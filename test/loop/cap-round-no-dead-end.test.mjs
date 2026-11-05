import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { capRoundActList } from "../../scripts/github/write-gate-context.mjs";
import { writeSealedGateDeltaRecord } from "../../scripts/loop/_gate-delta-record.mjs";
import { initGitFixture, runGitFixture } from "../_helpers.mjs";
import { coordinationAt, followRemedy, reviewerOnlyRoute } from "./_cap-round-route.mjs";

// Issue 3122 / ADR 0255: a draft PR past the cap round never dead-ends. Every combination of cap round, sequence state, base refreshes and later commits
// reaches mark_ready_for_review, or is an explicit expected block with its reason. Real functions throughout; only the network seams are injected (_cap-round-route.mjs).
const REPO = "owner/repo";
const PR = 70;
const ACT = { severity: "medium", summary: "guard missing", files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: "Guard", judgeFix: "add" };

/**
 * One scratch repo. History after the cap-round head A, in order: a fix commit (src/a.mjs), base refresh 1, a docs commit, base refresh 2, each when asked.
 * `sequence`: open (the fixer marker), closed (closed as head_moved, closed as no_commit or lost: all three leave no marker and no record, because a closure only removes the marker),
 * fixer_needs_fix (the fixer's non-clearing record at A, another actSetId, the same refs).
 */
function scenario({ clean, sequence, merges, fix, docs, orphaned = false, unreadable = false }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cap-matrix-"));
  initGitFixture(root, { branch: "main", commit: null });
  const git = (...args) => String(runGitFixture(root, args)).trim();
  const write = (rel, text) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
  const commit = (files, message) => { for (const [rel, text] of Object.entries(files)) write(rel, text); git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
  git("config", "commit.gpgsign", "false");
  const A = commit({ ".gitignore": "tmp/\n", "src/a.mjs": "export const a = 1;\n" }, "base");
  git("update-ref", "refs/remotes/origin/main", A);
  git("checkout", "-qb", "pr");
  const refresh = (n) => {
    git("checkout", "-q", "main");
    commit({ [`base-${n}.txt`]: `base ${n}\n` }, `base ${n}`);
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    git("checkout", "-q", "pr");
    git("merge", "-q", "--no-ff", "-m", `refresh ${n}`, "main");
  };
  const F = fix ? commit({ "src/a.mjs": "export const a = 2;\n" }, "fix") : A;
  if (merges >= 1) refresh(1);
  if (docs) commit({ "docs/x.md": "x\n" }, "docs");
  if (merges >= 2) refresh(2);
  // A rebase: the PR head's history no longer holds A.
  if (orphaned) { git("checkout", "-q", "--orphan", "rebased"); git("rm", "-rfq", "--cached", "."); commit({ "src/a.mjs": "export const a = 3;\n" }, "rebased"); }
  const head = git("rev-parse", "HEAD");
  const findings = clean ? [] : [ACT];
  const dir = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`);
  mkdirSync(dir, { recursive: true });
  for (const [i, h] of ["1".repeat(40), "2".repeat(40), "3".repeat(40), A].entries()) {
    writeFileSync(path.join(dir, `draft_gate-${h}.json`), JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", headSha: h, verdict: h === A && !clean ? "findings_present" : "clean", loggedAt: `2026-11-0${i + 1}T00:00:00.000Z`, findings: h === A ? findings : [] }));
  }
  if (unreadable) writeFileSync(path.join(dir, `draft_gate-${"2".repeat(40)}.json`), "{ not json");
  const tmpRoot = path.join(root, "tmp");
  if (sequence === "open") writeSequenceMarker({ tmpRoot, baselineHead: A, branch: "issue-1" });
  if (sequence === "fixer_needs_fix") {
    const items = capRoundActList(findings, A).map((item) => ({ ref: item.ref, status: "not_resolved" }));
    writeSealedGateDeltaRecord(tmpRoot, A, { reviewBaselineHead: A, candidateHead: F, actSetId: "fixer-act-set", invocation: 1, outcome: "needs_fix", nextStep: "fix_and_rereview", items });
  }
  return { root, A, head, ledgerPath: path.join(dir, `draft_gate-${A}.json`), hasPrOwnCommit: fix || docs };
}


// The end state of every combination. null: non-blocked (mark_ready_for_review or run_pre_approval_gate). Otherwise the expected block, with the proof failure and a trace pattern naming why.
const BLOCKS = {
  head_equals_baseline: { failure: "cap_round_unresolved", trace: /equals the baseline|no_cap_round_chain/ },
  active_sequence_marker: { failure: "no_clearing_record", trace: /active sequence marker/ },
  act_items_open: { failure: "no_clearing_record", trace: /needs_fix|no PR-own commit/ },
  needs_fix_without_commit: { failure: "no_clearing_record", trace: /no PR-own commit/ },
  chain_reaches_head: { failure: "items_do_not_cover", trace: /chain_reaches_head/ },
};
function expectedBlock({ clean, sequence, merges, fix, docs }) {
  if (!fix && !docs && merges === 0) return "head_equals_baseline";
  // The fixer's marker blocks the reviewer-only route; a clean cap round needs the route only for a code commit.
  if (sequence === "open" && (fix || !clean)) return "active_sequence_marker";
  // Open act items with no fix commit need a fixer pass: a truthful reviewer reports them not_resolved.
  if (!clean && !fix) return "act_items_open";
  if (clean && sequence === "fixer_needs_fix" && !fix) return docs ? "chain_reaches_head" : "needs_fix_without_commit";
  return null;
}

const combos = [];
for (const clean of [true, false]) for (const sequence of ["open", "closed", "fixer_needs_fix"]) for (const merges of [0, 1, 2]) for (const [fix, docs] of [[true, false], [false, true], [true, true], [false, false]]) combos.push({ clean, sequence, merges, fix, docs });

const READY = ["mark_ready_for_review", "run_pre_approval_gate"];
for (const combo of combos) {
  const name = `cap round ${combo.clean ? "clean" : "with act items"}, sequence ${combo.sequence === "closed" ? "closed (head_moved, no_commit or lost)" : combo.sequence}, ${combo.merges} base refresh(es), fix ${combo.fix}, docs ${combo.docs}`;
  test(name, async () => {
    const s = scenario(combo);
    try {
      const { trace, end } = await followRemedy(s.root, { repo: REPO, pr: PR, head: s.head, baseline: s.A, ledgerPath: s.ledgerPath, reviewerStatus: combo.clean || combo.fix ? "resolved" : "not_resolved" });
      const block = expectedBlock(combo);
      if (block === null) {
        assert.ok(READY.includes(end.nextAction), `${name}: ${end.nextAction} ${end.failure}: ${end.reason}\n${trace.join("\n")}`);
        return;
      }
      assert.equal(end.nextAction, "report_blocked", `${name}: expected the block ${block}`);
      assert.equal(end.failure, BLOCKS[block].failure, `${name}: ${block}`);
      assert.match(trace.join("\n"), BLOCKS[block].trace, `${name}: ${block}`);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  }, 60000);
}

// The remaining dead ends, each with its typed reason and the remedy the coordinator prints.
test("baseline_orphaned: a rebase removes the cap-round head, and only the replacement PR remains", async () => {
  const s = scenario({ clean: false, sequence: "lost", merges: 0, fix: true, docs: false, orphaned: true });
  try {
    const { end } = await followRemedy(s.root, { repo: REPO, pr: PR, head: s.head, baseline: s.A, ledgerPath: s.ledgerPath });
    assert.deepEqual({ next: end.nextAction, failure: end.failure }, { next: "report_blocked", failure: "baseline_orphaned" });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("cap_round_unresolved: an unreadable ledger blocks every route and names the repair", async () => {
  const s = scenario({ clean: false, sequence: "lost", merges: 0, fix: true, docs: false, unreadable: true });
  try {
    const { end } = await followRemedy(s.root, { repo: REPO, pr: PR, head: s.head, baseline: s.A, ledgerPath: s.ledgerPath });
    assert.deepEqual({ next: end.nextAction, failure: end.failure }, { next: "report_blocked", failure: "cap_round_unresolved" });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("bound 3 with an open finding: three reviewer-only runs seal bounded_out and the fourth refuses", async () => {
  const s = scenario({ clean: false, sequence: "lost", merges: 1, fix: true, docs: false });
  try {
    for (let i = 0; i < 3; i += 1) await reviewerOnlyRoute(s.root, { baseline: s.A, head: s.head, ledgerPath: s.ledgerPath, status: "not_resolved" });
    const { end } = await followRemedy(s.root, { repo: REPO, pr: PR, head: s.head, baseline: s.A, ledgerPath: s.ledgerPath, reviewerStatus: "not_resolved" });
    assert.equal(end.nextAction, "report_blocked");
    await assert.rejects(reviewerOnlyRoute(s.root, { baseline: s.A, head: s.head, ledgerPath: s.ledgerPath }), /invocation bound of 3 is reached.*restart_on_replacement_pr/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("synthetic twin of PR 3087: a non-clean cap round whose fixer needs_fix record has another actSetId but the same refs reaches ready", async () => {
  const s = scenario({ clean: false, sequence: "fixer_needs_fix", merges: 1, fix: true, docs: false });
  try {
    const before = await coordinationAt(s.root, { repo: REPO, pr: PR, head: s.head });
    assert.equal(before.nextAction, "report_blocked");
    const { end } = await followRemedy(s.root, { repo: REPO, pr: PR, head: s.head, baseline: s.A, ledgerPath: s.ledgerPath });
    assert.ok(READY.includes(end.nextAction), `${end.failure}: ${end.reason}`);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
