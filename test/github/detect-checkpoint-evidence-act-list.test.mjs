import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { buildFanoutEnforcement, buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";
import { initGitFixture } from "../_helpers.mjs";

// Merge's evidence probe refuses a current-head pre_approval_gate ledger whose
// judge act list is not empty, unreadable, or unjudged.

const HEAD = "abc1234def5678";
const CONFIG = { gates: { requireFanoutEvidence: true, draft: { required: true }, preApproval: { required: true } } };
const CONFIG_NO_FANOUT = { gates: { requireFanoutEvidence: false, draft: { required: true }, preApproval: { required: true } } };
const PA_MARKER = { visible: true, headSha: HEAD, executionMode: "fanout_fanin" };
const NO_DRAFT_MARKER = { visible: false };
const LEDGER_REL = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });

function cleanEvidenceFor(headSha) {
  return {
    currentHeadSha: headSha,
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha, sizeOutcome: "pass", sizeTouchesT1: false },
  };
}

const ACT_ITEM = { severity: "medium", angle: "correctness", summary: "retry loop never backs off", judgeDisposition: "act" };
const REJECTED_ITEM = { severity: "low", angle: "docs", summary: "reword the heading", judgeDisposition: "reject" };

function actListEnforcement(actList) {
  return { required: false, gates: [], actList: { ledgerPath: "tmp/ledger.json", unreadable: null, open: null, unjudged: null, ...actList } };
}

test("buildPreMergeGateCheck refuses a non-empty act list and names the ledger and items", () => {
  const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, actListEnforcement({ open: { path: "/w/tmp/ledger.json", items: [ACT_ITEM] } }));
  assert.equal(check.ok, false);
  assert.deepEqual(check.failures, ["pre_approval_gate: judge act list is not empty in /w/tmp/ledger.json (1 open act item(s): [medium] retry loop never backs off); fix each item and re-gate, or, for an item closed without a commit, rerun the judge at this head, rewrite the ledger with --judge-verdict, and re-post the verdict (GATE-COMMENT-VERDICT-VALUES)"]);
});

test("buildPreMergeGateCheck passes once the act list is empty", () => {
  const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, actListEnforcement({}));
  assert.equal(check.ok, true, JSON.stringify(check.failures));
});

test("skipFanoutLedgerCheck skips the act-list check like the other ledger checks", () => {
  const enforcement = actListEnforcement({ unreadable: { path: "/w/l.json" }, open: { path: "/w/l.json", items: [ACT_ITEM] } });
  const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement, { skipFanoutLedgerCheck: true });
  assert.equal(check.ok, true, JSON.stringify(check.failures));
});

async function withLedgerRepos(ledgers, fn) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-act-list-")));
  try {
    const repo = path.join(base, "a");
    await mkdir(repo, { recursive: true });
    initGitFixture(repo);
    const roots = [repo];
    for (let i = 1; i < ledgers.length; i += 1) {
      const wt = path.join(base, `wt${i}`);
      execFileSync("git", ["worktree", "add", "-q", "-b", `wt${i}`, wt], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
      roots.push(await realpath(wt));
    }
    for (let i = 0; i < ledgers.length; i += 1) {
      if (ledgers[i] === undefined) continue;
      const ledgerPath = path.join(roots[i], LEDGER_REL);
      await mkdir(path.dirname(ledgerPath), { recursive: true });
      const body = typeof ledgers[i] === "string" ? ledgers[i] : JSON.stringify({ repo: "owner/repo", pr: 42, gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", overallVerdict: "clean", executionMode: "fanout_fanin", ...ledgers[i] });
      await writeFile(ledgerPath, body, "utf8");
    }
    await fn(repo, roots);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function probe(repo, config = CONFIG, marker = PA_MARKER) {
  const enforcement = await buildFanoutEnforcement({
    repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
    draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: marker, config, cwd: repo,
  });
  return { enforcement, check: buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement) };
}

test("buildFanoutEnforcement reads the current-head pre_approval_gate act list from the ledger", async () => {
  await withLedgerRepos([{ findings: [ACT_ITEM, REJECTED_ITEM] }], async (repo) => {
    const { enforcement, check } = await probe(repo);
    assert.deepEqual(enforcement.actList.open.items.map((f) => f.summary), ["retry loop never backs off"]);
    assert.equal(check.ok, false);
    assert.ok(check.failures.some((f) => f.includes("judge act list is not empty") && f.includes(LEDGER_REL) && f.includes("retry loop never backs off")), JSON.stringify(check.failures));
  });
});

test("buildFanoutEnforcement reports an empty act list when every finding is rejected or deferred", async () => {
  await withLedgerRepos([{ findings: [REJECTED_ITEM, { ...ACT_ITEM, judgeDisposition: "defer" }] }], async (repo) => {
    const { enforcement, check } = await probe(repo);
    assert.equal(enforcement.actList.open, null);
    assert.ok(!check.failures.some((f) => f.includes("judge act list")), JSON.stringify(check.failures));
  });
});

test("a malformed ledger fails closed with one unreadable-ledger failure", async () => {
  for (const body of ["{not json", JSON.stringify({ findings: "nope" })]) {
    await withLedgerRepos([body], async (repo, roots) => {
      const { check } = await probe(repo);
      const hits = check.failures.filter((f) => f.includes("judge act list"));
      assert.deepEqual(hits, [`pre_approval_gate: findings-log ledger is unreadable or malformed (${path.join(roots[0], LEDGER_REL)}); cannot verify the judge act list (GATE-COMMENT-VERDICT-VALUES)`]);
    });
  }
});

test("a missing ledger adds no act-list failure", async () => {
  await withLedgerRepos([undefined], async (repo) => {
    const { enforcement, check } = await probe(repo);
    assert.equal(enforcement.actList, undefined);
    assert.ok(!check.failures.some((f) => f.includes("judge act list")), JSON.stringify(check.failures));
    assert.ok(check.failures.some((f) => f.includes("no findings-log ledger exists")), JSON.stringify(check.failures));
  });
});

test("an unjudged fanout_fanin ledger with findings fails closed", async () => {
  await withLedgerRepos([{ findings: [REJECTED_ITEM, { severity: "medium", angle: "x", summary: "s" }] }], async (repo, roots) => {
    const { check } = await probe(repo);
    assert.ok(check.failures.includes(`pre_approval_gate: judge act list unknown in ${path.join(roots[0], LEDGER_REL)} (1 finding(s) carry no judge disposition); write the ledger with --judge-verdict (GATE-COMMENT-VERDICT-VALUES)`), JSON.stringify(check.failures));
  });
});

test("zero findings and inline rounds need no judge", async () => {
  const inlineMarker = { ...PA_MARKER, executionMode: "inline_single_agent" };
  const cases = [[{ findings: [] }, PA_MARKER], [{ executionMode: "inline_single_agent", findings: [{ severity: "low", angle: "x", summary: "s" }] }, inlineMarker]];
  for (const [ledger, marker] of cases) {
    await withLedgerRepos([ledger], async (repo) => {
      const { check } = await probe(repo, CONFIG_NO_FANOUT, marker);
      assert.ok(!check.failures.some((f) => f.includes("judge act list")), JSON.stringify(check.failures));
    });
  }
});

test("an unjudged ledger under a fanout_fanin marker fails closed whatever the ledger's own executionMode", async () => {
  for (const executionMode of [undefined, "inline_single_agent"]) {
    await withLedgerRepos([{ executionMode, findings: [{ severity: "medium", angle: "x", summary: "s" }] }], async (repo) => {
      const { check } = await probe(repo, CONFIG_NO_FANOUT);
      assert.ok(check.failures.some((f) => f.includes("judge act list unknown")), JSON.stringify(check.failures));
    });
  }
});

test("the act-list check runs when requireFanoutEvidence is disabled", async () => {
  await withLedgerRepos([{ findings: [ACT_ITEM] }], async (repo) => {
    const { enforcement, check } = await probe(repo, CONFIG_NO_FANOUT);
    assert.equal(enforcement.required, false);
    assert.equal(check.ok, false);
    assert.ok(check.failures.some((f) => f.includes("judge act list is not empty")), JSON.stringify(check.failures));
  });
  await withLedgerRepos([undefined], async (repo) => {
    const { enforcement, check } = await probe(repo, CONFIG_NO_FANOUT);
    assert.deepEqual(enforcement, { required: false, gates: [] });
    assert.equal(check.ok, true, JSON.stringify(check.failures));
  });
});

test("a checkout with an empty act list never shadows one with act items", async () => {
  await withLedgerRepos([{ findings: [REJECTED_ITEM] }, { findings: [ACT_ITEM] }], async (repo, roots) => {
    const { check } = await probe(repo);
    assert.equal(check.ok, false);
    const hit = check.failures.find((f) => f.includes("judge act list is not empty"));
    assert.ok(hit && hit.includes(path.join(roots[1], LEDGER_REL)), JSON.stringify(check.failures));
  });
});

test("only a visible current-head pre_approval_gate marker reads the act list", async () => {
  await withLedgerRepos([{ findings: [ACT_ITEM] }], async (repo) => {
    // An act-item ledger also exists at the old head, so only the head check keeps it out.
    const oldHead = "0ddba11c0ffee0";
    const oldLedger = path.join(repo, buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: oldHead, tmpRoot: "tmp" }));
    await writeFile(oldLedger, JSON.stringify({ executionMode: "fanout_fanin", findings: [ACT_ITEM] }), "utf8");
    for (const marker of [{ ...PA_MARKER, headSha: oldHead }, { ...PA_MARKER, visible: false }]) {
      const { enforcement, check } = await probe(repo, CONFIG_NO_FANOUT, marker);
      assert.equal(enforcement.actList, undefined);
      assert.ok(!check.failures.some((f) => f.includes("judge act list")), JSON.stringify(check.failures));
    }
  });
});

test("a judged copy never shadows an unjudged copy in another checkout", async () => {
  await withLedgerRepos([{ findings: [REJECTED_ITEM] }, { findings: [{ severity: "medium", angle: "x", summary: "s" }] }], async (repo, roots) => {
    const { check } = await probe(repo);
    assert.ok(check.failures.includes(`pre_approval_gate: judge act list unknown in ${path.join(roots[1], LEDGER_REL)} (1 finding(s) carry no judge disposition); write the ledger with --judge-verdict (GATE-COMMENT-VERDICT-VALUES)`), JSON.stringify(check.failures));
  });
});

test("a malformed copy fails closed even when another checkout's copy parses", async () => {
  await withLedgerRepos(["{not json", { findings: [] }], async (repo, roots) => {
    const { check } = await probe(repo);
    const hits = check.failures.filter((f) => f.includes("judge act list"));
    assert.deepEqual(hits, [`pre_approval_gate: findings-log ledger is unreadable or malformed (${path.join(roots[0], LEDGER_REL)}); cannot verify the judge act list (GATE-COMMENT-VERDICT-VALUES)`]);
  });
});

test("a disposition outside act/defer/reject is malformed in any execution mode", async () => {
  const inlineMarker = { ...PA_MARKER, executionMode: "inline_single_agent" };
  for (const judgeDisposition of ["bogus", " ", ""]) {
    for (const marker of [PA_MARKER, inlineMarker]) {
      await withLedgerRepos([{ findings: [REJECTED_ITEM, { ...ACT_ITEM, judgeDisposition }] }], async (repo, roots) => {
        const { check } = await probe(repo, CONFIG_NO_FANOUT, marker);
        const hits = check.failures.filter((f) => f.includes("judge act list"));
        assert.deepEqual(hits, [`pre_approval_gate: findings-log ledger is unreadable or malformed (${path.join(roots[0], LEDGER_REL)}); cannot verify the judge act list (GATE-COMMENT-VERDICT-VALUES)`]);
      });
    }
  }
});
