import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { buildFanoutEnforcement, buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { buildLogPath, writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { resolveGateArtifactTmpRoot, resolveLedgerCheckouts, resolveMainWorktreeRoot } from "../../scripts/loop/_repo-root-resolver.mjs";
import { initGitFixture } from "../_helpers.mjs";

// gate findings-log ledgers must land under the MAIN checkout's tmp/,
// not the ephemeral linked worktree's cwd — so the orchestrator's merge (which
// runs from the main checkout) can read the provenance a coordinator wrote
// inside a linked worktree, and the ledger survives worktree pruning.

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

async function makeRepoWithWorktrees() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-2315-")));
  const main = path.join(base, "main");
  await mkdir(main, { recursive: true });
  initGitFixture(main);
  const linked = path.join(base, "linked");
  git(main, ["worktree", "add", "-q", "-b", "feature", linked]);
  return { base, main, linked: await realpath(linked) };
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

const HEAD = "abc1234def5678";
const PROV = JSON.stringify({
  distinctReviewers: 4,
  perAngle: [
    { angle: "dry", reviewer: "review-a" },
    { angle: "kiss", reviewer: "review-b" },
    { angle: "pr-checklist", reviewer: "review-c" },
    { angle: "holistic", reviewer: "review-d" },
  ],
});

test("resolveMainWorktreeRoot returns the SAME main checkout from main and from a linked worktree", async () => {
  const { base, main, linked } = await makeRepoWithWorktrees();
  try {
    assert.equal(await realpath(resolveMainWorktreeRoot(main)), main);
    assert.equal(await realpath(resolveMainWorktreeRoot(linked)), main, "a linked worktree must resolve to the main checkout");
    const tmpRoot = resolveGateArtifactTmpRoot(linked);
    assert.equal(path.basename(tmpRoot), "tmp", "the gate-artifact tmp root is a tmp/ dir");
    assert.equal(
      await realpath(path.dirname(tmpRoot)),
      main,
      "the gate-artifact tmp root anchors at the main checkout",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("env-safety: resolveMainWorktreeRoot and resolveLedgerCheckouts ignore an inherited GIT_DIR/GIT_WORK_TREE pointing at a DIFFERENT repo", async () => {
  // The merge-time reader (buildFanoutEnforcement -> resolveLedgerCheckouts) and
  // the writer's anchor both spawn `git worktree list`; an ambient GIT_DIR would
  // otherwise override cwd and enumerate the wrong repo, reporting missing
  // provenance. Both must pin to their cwd's repo regardless of the env.
  const { base, main, linked } = await makeRepoWithWorktrees();
  const other = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-2315-other-")));
  initGitFixture(other);
  const savedDir = process.env.GIT_DIR;
  const savedWt = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(other, ".git");
  process.env.GIT_WORK_TREE = other;
  try {
    assert.equal(await realpath(resolveMainWorktreeRoot(main)), main, "main anchor must ignore the redirected GIT_DIR");
    const checkouts = await Promise.all(resolveLedgerCheckouts(main).map((p) => realpath(p).catch(() => p)));
    assert.ok(checkouts.includes(main), `ledger checkouts must enumerate the real repo (got ${JSON.stringify(checkouts)})`);
    assert.ok(checkouts.includes(linked), "ledger checkouts must include the linked worktree");
    assert.ok(!checkouts.includes(other), "ledger checkouts must NOT enumerate the redirected repo");
  } finally {
    if (savedDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedDir;
    if (savedWt === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = savedWt;
    await rm(other, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});

test("AC1: a gate run whose cwd is a linked worktree writes its ledger under the MAIN checkout tmp/, not the worktree's", async () => {
  const { base, main, linked } = await makeRepoWithWorktrees();
  try {
    // repoRoot = the LINKED worktree, exactly as a coordinator running the gate
    // inside tmp/worktrees/<slug> would resolve it.
    await writeGateFindingsLog(
      { repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]", executionMode: "fanout_fanin", provenance: PROV },
      { repoRoot: linked },
    );

    const rel = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });
    assert.equal(await exists(path.join(main, rel)), true, "ledger must exist under the MAIN checkout tmp/");
    assert.equal(await exists(path.join(linked, rel)), false, "ledger must NOT be written under the linked worktree tmp/");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("AC3: the ledger records the real executionMode (fanout_fanin), never null", async () => {
  const { base, main, linked } = await makeRepoWithWorktrees();
  try {
    await writeGateFindingsLog(
      { repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]", executionMode: "fanout_fanin", provenance: PROV },
      { repoRoot: linked },
    );
    const rel = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });
    const ledger = JSON.parse(await readFile(path.join(main, rel), "utf8"));
    assert.equal(ledger.executionMode, "fanout_fanin");
    assert.notEqual(ledger.executionMode, null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("AC3: an inline (default) ledger records executionMode inline_single_agent", async () => {
  const { base, main, linked } = await makeRepoWithWorktrees();
  try {
    await writeGateFindingsLog(
      { repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]" },
      { repoRoot: linked },
    );
    const rel = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });
    const ledger = JSON.parse(await readFile(path.join(main, rel), "utf8"));
    assert.equal(ledger.executionMode, "inline_single_agent");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("AC2: a worktree-written fanout_fanin ledger's provenance is verifiable from the MAIN checkout AFTER the worktree is pruned; merge preconditions pass", async () => {
  const { base, main, linked } = await makeRepoWithWorktrees();
  try {
    // Write from the LINKED worktree (the coordinator's cwd).
    await writeGateFindingsLog(
      { repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]", executionMode: "fanout_fanin", provenance: PROV },
      { repoRoot: linked },
    );

    // Prune the linked worktree, exactly as post-merge cleanup would. This is
    // the load-bearing step: pre-fix the ledger lived under the linked worktree
    // and is now GONE (resolveLedgerCheckouts can no longer enumerate it), so
    // the merge would refuse for missing provenance. Post-fix it is at the main
    // worktree and still reachable.
    git(main, ["worktree", "remove", "--force", linked]);
    git(main, ["worktree", "prune"]);

    // Read/enforce from the MAIN checkout (the orchestrator's cwd at merge).
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: { visible: false },
      preApprovalGateMarker: { visible: true, headSha: HEAD, executionMode: "fanout_fanin" },
      config: { gates: { requireFanoutEvidence: true, requireFanoutProvenance: true, draft: { required: true }, preApproval: { required: true } } },
      cwd: main,
    });
    const pa = enforcement.gates.find((g) => g.name === "pre_approval_gate");
    assert.ok(pa && pa.provenance, "provenance written in the worktree must be readable from the main checkout");
    assert.equal(pa.provenance.distinctReviewers, 4);

    const evidence = {
      currentHeadSha: HEAD,
      draftGate: { visible: true, verdict: "clean" },
      preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: HEAD, sizeOutcome: "pass", sizeTouchesT1: false },
    };
    const check = buildPreMergeGateCheck(evidence, 0, null, enforcement);
    assert.equal(check.ok, true, JSON.stringify(check.failures));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reader-side: a ledger written from one linked worktree is found by a reader anchoring at the main worktree from a DIFFERENT cwd (carry-forward / emit / disposition-memory)", async () => {
  const { base, main, linked } = await makeRepoWithWorktrees();
  try {
    // A prior round writes its ledger from the linked worktree (lands in main).
    await writeGateFindingsLog(
      { repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]", executionMode: "fanout_fanin", provenance: PROV },
      { repoRoot: linked },
    );

    // The ledger readers (resolve-angle-carry-forward, write-gate-context's
    // prior-disposition read, emit's re-gate scan) resolve the ledger path via
    // `path.resolve(repoRoot, buildLogPath({ tmpRoot: resolveGateArtifactTmpRoot(repoRoot) }))`.
    // Replicate that from BOTH the main checkout and the linked worktree cwd;
    // both must resolve to the same main-anchored ledger and read it back.
    for (const readerCwd of [main, linked]) {
      const logPath = buildLogPath({
        repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD,
        tmpRoot: resolveGateArtifactTmpRoot(readerCwd),
      });
      const ledger = JSON.parse(await readFile(path.resolve(readerCwd, logPath), "utf8"));
      assert.equal(ledger.provenance.distinctReviewers, 4, `reader at ${readerCwd} must read the main-anchored ledger`);
      assert.equal(ledger.executionMode, "fanout_fanin");
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reader-side (load-bearing): emit-fanout-dispatch's re-gate guard fires off the MAIN-anchored prior ledger when run from a linked-worktree cwd", async () => {
  // The documented fail-open: if emit's re-gate ledger scan resolved
  // cwd-relative, a coordinator in a linked worktree would miss a prior round's
  // main-anchored ledger, treat the re-gate as a first round, and BYPASS the
  // carry-forward guard. Reverting emit's ledgerTmpRoot back to `|| "tmp"` makes
  // this test pass exit 0 (no refusal) — so it fails closed on that regression.
  const { base, main, linked } = await makeRepoWithWorktrees();
  try {
    const emitCli = path.resolve("scripts/github/emit-fanout-dispatch.mjs");
    const repo = "owner/repo";
    const pr = "42";
    const gate = "pre_approval_gate";
    const cur = "a".repeat(40);
    const prior = "d".repeat(40);
    const slug = "owner-repo";

    // A prior-round findings-log ledger for THIS gate at a DIFFERENT head, written
    // under the MAIN worktree (where the writer now anchors it). Its presence makes
    // `cur` a re-gate.
    const ledgerDir = path.join(main, "tmp", "gate-findings", slug, `pr-${pr}`);
    await mkdir(ledgerDir, { recursive: true });
    await writeFile(path.join(ledgerDir, `${gate}-${prior}.json`), JSON.stringify({
      repo, pr: 42, gate, headSha: prior, verdict: "findings_present",
      findings: [{ angle: "contradiction-lens", severity: "low", summary: "x" }],
      provenance: { perAngle: [{ angle: "contradiction-lens", reviewer: "r" }] },
    }), "utf8");

    // The gate-context bundle for the CURRENT head stays worktree-local (in the
    // LINKED worktree's tmp/, exactly where a coordinator writes it).
    const ctxDir = path.join(linked, "tmp", "gate-context", slug, `pr-${pr}`);
    await mkdir(ctxDir, { recursive: true });
    await writeFile(path.join(ctxDir, `${gate}-${cur}.briefing-prefix.txt`), "## prefix\n", "utf8");
    await writeFile(path.join(ctxDir, `${gate}-${cur}.briefing-volatile.txt`), "# volatile\n", "utf8");
    await writeFile(path.join(ctxDir, `${gate}-${cur}.json`), JSON.stringify({
      fanout: { groups: [{ name: "contradiction-lens", angles: ["contradiction-lens"] }], pendingGroups: [{ name: "contradiction-lens", angles: ["contradiction-lens"] }] },
    }), "utf8");

    // Run emit from the LINKED worktree cwd with NO --tmp-root and NO carry-forward
    // plan. The re-gate ledger scan must reach the MAIN-anchored prior ledger and
    // refuse for the missing carry-forward plan.
    const result = spawnSync("node", [emitCli, "--repo", repo, "--pr", pr, "--gate", gate, "--head-sha", cur], { cwd: linked, encoding: "utf8" });
    assert.equal(result.status, 1, `expected re-gate refusal; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stdout, /GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("AC4: pruning the linked worktree does NOT remove the ledger (it lives in the main checkout)", async () => {
  const { base, main, linked } = await makeRepoWithWorktrees();
  try {
    await writeGateFindingsLog(
      { repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]", executionMode: "fanout_fanin", provenance: PROV },
      { repoRoot: linked },
    );
    const rel = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });
    assert.equal(await exists(path.join(main, rel)), true);

    // Remove the linked worktree as post-merge cleanup would.
    git(main, ["worktree", "remove", "--force", linked]);
    git(main, ["worktree", "prune"]);
    assert.equal(await exists(linked), false, "linked worktree is gone");
    assert.equal(await exists(path.join(main, rel)), true, "ledger survives in the main checkout");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
