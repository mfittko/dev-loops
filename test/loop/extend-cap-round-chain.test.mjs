import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";

import { withSequenceLock } from "@dev-loops/core/loop/fix-push-authority";
import { renderCliText } from "@dev-loops/core/loop/cli-command";
import { CAP_ROUND_REFUSAL, replacementPrOperatorRecovery } from "@dev-loops/core/loop/pr-gate-coordination";
import { shellQuote } from "../../scripts/lib/checkout-delegation-refusal.mjs";

import { resolveCapRoundFixed } from "../../scripts/github/write-gate-context.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { gateCoverRecordPath, gateDeltaRecordPath, readGateDeltaRecord, readSealedCoverRecord, readSealedGateDeltaRecord, writeCoverRecord, writeSealedGateDeltaRecord } from "../../scripts/loop/_gate-delta-record.mjs";
import { extendCapRoundChain, parseExtendCapRoundChainCliArgs, runCli } from "../../scripts/loop/extend-cap-round-chain.mjs";
import { initGitFixture, runGitFixture, spawnSyncTrusted } from "../_helpers.mjs";
import { runCli as runDeltaCli } from "../../scripts/loop/check-pre-push-delta.mjs";
import { sealDeltaFixture } from "./_seal-fixture.mjs";
import { coordinationAt, followRemedy } from "./_cap-round-route.mjs";

const REPO = "owner/repo";
const PR = 70;
// A deterministic signal for the lock tests (issue 3443 round 4): `reached` resolves when the tool attempts its lock, which is after every pre-lock read, so no sleep decides the order. The wrapped lock is the real one.
const lockAttempt = () => {
  let signal;
  const reached = new Promise((resolve) => { signal = resolve; });
  return { reached, withLock: (tmpRoot, heads, fn) => { signal(); return withSequenceLock(tmpRoot, heads, fn); } };
};
// RECOVERY-COMMAND-REQUIRED: the fetch recovery acts on the resolved worktree, never the caller cwd (issue 3443 round 4).
const fetchIn = (root, sha) => `git -C ${shellQuote(path.resolve(root))} fetch origin ${sha}`;

const commit = async (root, files, message) => {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf8");
  }
  runGitFixture(root, ["add", "-A"]);
  runGitFixture(root, ["commit", "-q", "-m", message]);
  return String(runGitFixture(root, ["rev-parse", "HEAD"])).trim();
};

/** Cap round at A, sealed clearing record A to B (the fixer commit), the checkout at B. */
async function capFixture({ findings = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "extend-cap-chain-"));
  initGitFixture(root, { commit: null });
  const A = await commit(root, { ".gitignore": "tmp/\n", "src/a.mjs": "export const a = 1;\n" }, "base");
  const B = await commit(root, { "src/a.mjs": "export const a = 2;\n" }, "fixer");
  const dir = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`);
  await mkdir(dir, { recursive: true });
  for (const [i, head] of ["1".repeat(40), "2".repeat(40), "3".repeat(40), A].entries()) {
    await writeFile(path.join(dir, `draft_gate-${head}.json`), JSON.stringify({
      repo: REPO, pr: PR, gate: "draft_gate", headSha: head, verdict: "findings_present", loggedAt: `2026-11-0${i + 1}T00:00:00.000Z`, findings: head === A ? findings : [],
    }), "utf8");
  }
  runGitFixture(root, ["update-ref", "refs/remotes/origin/main", A]);
  writeSealedGateDeltaRecord(path.join(root, "tmp"), A, { reviewBaselineHead: A, candidateHead: B, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
  return { root, A, B };
}

const extend = (root, head, deps = {}) => extendCapRoundChain({ repo: REPO, pr: PR, worktree: root }, { detectOriginSlug: () => REPO, fetchPr: async () => ({ headRefOid: head, baseRefName: "main" }), fetchBaseBranch: () => {}, ...deps });
const proof = (root, head) => resolveCapRoundFixed({ repo: REPO, pr: PR, headSha: head, baseRefName: "main" }, { repoRoot: root });

test("a docs-only commit on top of the sealed chain is proven only after the extension", async () => {
  const { root, B } = await capFixture();
  try {
    const D = await commit(root, { "docs/decisions/0001-x.md": "# x\n" }, "docs");
    assert.equal(await proof(root, D), null, "before the extension the chain stops at the fixer commit");
    const result = await extend(root, D);
    assert.deepEqual({ ...result }, { ok: true, action: "chain_extended", chainEnd: B, candidateHead: D, files: ["docs/decisions/0001-x.md"] });
    assert.ok(await proof(root, D));
    const record = readSealedGateDeltaRecord(path.join(root, "tmp"), B);
    assert.equal(record.extension, "docs_tests_only");
    const again = await extend(root, D);
    assert.equal(again.action, "already_proven");
    assert.equal(again.chainEnd, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-ASCII docs filename is classified by its real path, not a C-quoted one", async () => {
  const { root, B } = await capFixture();
  try {
    const D = await commit(root, { "docs/café.md": "c\n" }, "docs");
    const result = await extend(root, D);
    assert.deepEqual({ ...result }, { ok: true, action: "chain_extended", chainEnd: B, candidateHead: D, files: ["docs/café.md"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tests-only commit extends the chain", async () => {
  const { root } = await capFixture();
  try {
    const T = await commit(root, { "test/a.test.mjs": "// t\n" }, "tests");
    assert.equal((await extend(root, T)).action, "chain_extended");
    assert.ok(await proof(root, T));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a logic commit, alone or mixed with docs, refuses and writes no record", async () => {
  const { root, B } = await capFixture();
  try {
    const L = await commit(root, { "src/b.mjs": "export const b = 1;\n" }, "logic");
    const refused = await extend(root, L);
    assert.equal(refused.reason, "logic_commit_in_range");
    // RECOVERY-COMMAND-REQUIRED: the delta recovery and remedy name the resolved worktree, so they run from any caller directory.
    assert.match(refused.recovery, /loop pre-push-delta --reviewer-only .* --worktree \S+$/u);
    assert.match(refused.detail, /--result-path <result-file> --worktree \S+, have the reviewer/u);
    assert.match(refused.detail, /src\/b\.mjs/);
    assert.match(refused.detail, /pre-push-delta --reviewer-only --repo \S+ --pr \d+ --baseline /u);
    const M = await commit(root, { "docs/x.md": "x\n", "src/c.mjs": "export const c = 1;\n" }, "mixed");
    assert.equal((await extend(root, M)).reason, "logic_commit_in_range");
    assert.equal(readSealedGateDeltaRecord(path.join(root, "tmp"), B), null);
    assert.equal(await proof(root, M), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a PR head that is not the worktree HEAD and a PR with no cap-round chain", async () => {
  const { root } = await capFixture();
  try {
    await commit(root, { "docs/y.md": "y\n" }, "docs");
    const branch = String(runGitFixture(root, ["symbolic-ref", "--short", "HEAD"])).trim();
    const onBranch = (head) => ({ fetchPr: async () => ({ headRefOid: head, headRefName: branch, baseRefName: "main" }) });
    const mismatch = await extend(root, "9".repeat(40), onBranch("9".repeat(40)));
    assert.equal(mismatch.reason, "head_mismatch");
    // A checkout on another branch (the primary checkout on main) must never be fast-forwarded onto the PR head.
    const otherBranch = await extend(root, "9".repeat(40), { fetchPr: async () => ({ headRefOid: "9".repeat(40), headRefName: "pr-branch", baseRefName: "main" }) });
    assert.equal(otherBranch.reason, "head_mismatch");
    assert.match(otherBranch.recovery, /^operator: check out the PR branch pr-branch .*--worktree/u);
    assert.doesNotMatch(otherBranch.recovery, /pull --ff-only/u);
    // RECOVERY-COMMAND-REQUIRED (issue 3437): the fast-forward runs against the resolved --worktree, never the caller's cwd.
    assert.equal(mismatch.recovery, `git -C ${shellQuote(path.resolve(root))} pull --ff-only origin ${"9".repeat(40)}`);
    // An unpushed local commit ahead of the PR head, or a worktree diverged from it: checkout cannot fast-forward, so the recovery is the operator form.
    const aheadHead = String(runGitFixture(root, ["rev-parse", "HEAD~1"])).trim();
    const ahead = await extend(root, aheadHead, onBranch(aheadHead));
    assert.equal(ahead.reason, "head_mismatch");
    assert.match(ahead.recovery, /^operator: push the local commits to the PR branch/u);
    const side = String(runGitFixture(root, ["commit-tree", "-p", "HEAD~1", "-m", "side", "HEAD^{tree}"])).trim();
    const diverged = await extend(root, side, onBranch(side));
    assert.equal(diverged.reason, "head_mismatch");
    assert.match(diverged.recovery, /^operator: push the local commits to the PR branch/u, "a diverged worktree is not fixed by a fast-forward");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const bare = await mkdtemp(path.join(os.tmpdir(), "extend-cap-chain-"));
  try {
    initGitFixture(bare, { commit: null });
    const head = await commit(bare, { "docs/z.md": "z\n" }, "docs");
    const refused = await extend(bare, head);
    assert.equal(refused.reason, "no_cap_round_chain");
    assert.match(refused.detail, /no extension is needed\. Run .*loop gate-coordination --repo owner\/repo --pr 70: it routes to the next draft_gate round/);
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test("a logic commit refuses even with diff.relative set and the worktree in a subdirectory", async () => {
  const { root } = await capFixture();
  try {
    await commit(root, { "docs/y.md": "y\n" }, "docs");
    runGitFixture(root, ["config", "diff.relative", "true"]);
    const L = await commit(root, { "src/b.mjs": "export const b = 1;\n" }, "logic");
    const refused = await extend(path.join(root, "docs"), L);
    assert.equal(refused.reason, "logic_commit_in_range");
    assert.match(refused.detail, /node <dev-loops-package-root>\/cli\/index\.mjs loop gate-coordination --repo owner\/repo --pr 70/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-covering chain end is not picked and nothing is written", async () => {
  const act = { severity: "medium", summary: "guard missing", files: ["src/a.mjs"], line: 1, judgeDisposition: "act", judgeTitle: "Guard", judgeFix: "add" };
  const { root, B } = await capFixture({ findings: [act] });
  try {
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const refused = await extend(root, D);
    assert.equal(refused.reason, "no_cap_round_chain");
    assert.equal(readSealedGateDeltaRecord(path.join(root, "tmp"), B), null);
    assert.equal(await proof(root, D), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a base-only merge after the chain end does not block", async () => {
  const { root, A, B } = await capFixture();
  try {
    runGitFixture(root, ["checkout", "-q", "-b", "base-side", A]);
    const X = await commit(root, { "src/base.mjs": "export const base = 1;\n" }, "base logic");
    runGitFixture(root, ["update-ref", "refs/remotes/origin/main", X]);
    runGitFixture(root, ["checkout", "-q", "-"]);
    runGitFixture(root, ["checkout", "-q", B]);
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    runGitFixture(root, ["merge", "-q", "--no-ff", "-m", "merge base", X]);
    const M = String(runGitFixture(root, ["rev-parse", "HEAD"])).trim();
    const result = await extend(root, M);
    assert.equal(result.action, "chain_extended");
    assert.deepEqual(result.files, ["docs/d.md"]);
    assert.ok(D);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rebase that orphans the cap-round head refuses with the replacement-PR restart", async () => {
  const { root } = await capFixture();
  try {
    runGitFixture(root, ["checkout", "-q", "--orphan", "rebased"]);
    const R = await commit(root, { "docs/r.md": "r\n" }, "rebased");
    const refused = await extend(root, R);
    assert.equal(refused.reason, "baseline_orphaned");
    assert.match(refused.detail, /--allow-replacement-pr/);
    // RECOVERY-COMMAND-REQUIRED: the restart is an operator decision, so the recovery is the operator form with the full procedure.
    assert.equal(refused.recovery, renderCliText(replacementPrOperatorRecovery(PR)));
    assert.match(refused.recovery, /^operator: .*git push origin HEAD:<new-branch>.*loop pre-pr-review.*pr create --head <new-branch> --allow-replacement-pr 70.*close PR #70$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("under CLAUDECODE every extend-cap-round-chain recovery is rendered in the launcher form and matches the reviewer-only replacement recovery", async () => {
  const { root } = await capFixture();
  const saved = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
  try {
    runGitFixture(root, ["checkout", "-q", "--orphan", "rebased"]);
    const R = await commit(root, { "docs/r.md": "r\n" }, "rebased");
    const refused = await extend(root, R);
    assert.equal(refused.reason, "baseline_orphaned");
    assert.equal(refused.recovery, renderCliText(replacementPrOperatorRecovery(PR)));
    assert.doesNotMatch(refused.recovery, /<dev-loops-package-root>/u);
    assert.match(refused.recovery, /dev-loops-run --repo-root <checkout> cli\/index\.mjs pr create/u);
  } finally {
    if (saved === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved;
    await rm(root, { recursive: true, force: true });
  }
});

test("the cap-round head equal to the head, or an unfetched cap-round head, refuses no_cap_round_chain, never baseline_orphaned", async () => {
  const { root, A } = await capFixture();
  try {
    runGitFixture(root, ["checkout", "-q", A]);
    const equal = await extend(root, A);
    assert.equal(equal.reason, "no_cap_round_chain");
    // The cap-round head is the PR head: a reviewer-only run with that baseline is refused, so the recovery names the head-moving commit instead.
    assert.match(equal.detail, /the cap-round head is the PR head, so no commit follows it/u);
    assert.match(equal.recovery, /^operator: push one docs or tests commit to the PR branch, then rerun /u);
    assert.doesNotMatch(equal.recovery, /--reviewer-only/u);
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const gone = "a".repeat(40);
    const dir = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`);
    await writeFile(path.join(dir, `draft_gate-${gone}.json`), JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", headSha: gone, verdict: "findings_present", loggedAt: "2026-11-09T00:00:00.000Z", findings: [] }), "utf8");
    const unfetched = await extend(root, D, { fetchPr: async () => ({ headRefOid: D, baseRefName: "trunk" }) });
    assert.equal(unfetched.reason, "no_cap_round_chain");
    assert.match(unfetched.detail, /`git -C \S+ rev-parse --is-shallow-repository`.*`git -C \S+ fetch --unshallow`.*`git -C \S+ fetch origin a{40}`/);
    assert.match(unfetched.detail, /rerun `[^`]*gate extend-cap-round-chain --repo owner\/repo --pr \d+ --worktree \S+`/);
    assert.match(unfetched.detail, /still absent.*replacement PR/);
    assert.equal(unfetched.recovery, fetchIn(root, "a".repeat(40)));
    assert.doesNotMatch(unfetched.detail, /fetch origin (trunk|main)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli maps a refusal and a thrown failure to a stderr JSON with exit 1", async () => {
  const { root } = await capFixture();
  try {
    const sink = () => { const chunks = []; return { chunks, write: (s) => { chunks.push(s); } }; };
    const stdout = sink();
    const stderr = sink();
    const code = await runCli(["--repo", REPO, "--pr", String(PR), "--worktree", root], { stdout, stderr, detectOriginSlug: () => REPO, fetchPr: async () => { throw new Error("gh down"); } });
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stderr.chunks.join("")), { ok: false, refused: true, reason: "writer_error", detail: "gh down", recovery: renderCliText(`node <dev-loops-package-root>/cli/index.mjs gate extend-cap-round-chain --repo ${REPO} --pr ${PR} --worktree ${shellQuote(path.resolve(root))}`) });
    const refusedErr = sink();
    assert.equal(await runCli(["--repo", REPO, "--pr", String(PR), "--worktree", root], { stdout, stderr: refusedErr, detectOriginSlug: () => REPO, fetchPr: async () => ({}) }), 1);
    assert.equal(JSON.parse(refusedErr.chunks.join("")).reason, "pr_state_unreadable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const gitSha = (root) => String(runGitFixture(root, ["rev-parse", "HEAD"])).trim();

test("a non-base-only merge whose resolution changes logic refuses and writes no record", async () => {
  const { root, B } = await capFixture();
  try {
    runGitFixture(root, ["checkout", "-q", "-b", "side", B]);
    await commit(root, { "docs/side.md": "s\n" }, "side docs");
    runGitFixture(root, ["checkout", "-q", B]);
    await commit(root, { "docs/d.md": "d\n" }, "docs");
    runGitFixture(root, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
    const M = await commit(root, { "src/a.mjs": "export const a = 99;\n" }, "evil merge");
    const refused = await extend(root, M);
    assert.equal(refused.reason, "logic_commit_in_range");
    assert.match(refused.detail, /is not a base-only merge/);
    assert.equal(readSealedGateDeltaRecord(path.join(root, "tmp"), B), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale origin/<base> is refreshed by the fetch before the range is computed", async () => {
  const { root, A, B } = await capFixture();
  try {
    runGitFixture(root, ["checkout", "-q", "-b", "base-side", A]);
    const X = await commit(root, { "src/base.mjs": "export const base = 1;\n" }, "base logic");
    runGitFixture(root, ["checkout", "-q", B]);
    await commit(root, { "docs/d.md": "d\n" }, "docs");
    runGitFixture(root, ["merge", "-q", "--no-ff", "-m", "merge base", X]);
    const M = gitSha(root);
    assert.equal((await extend(root, M)).reason, "logic_commit_in_range", "origin/main still at the old tip");
    const fetchBaseBranch = (branch) => { assert.equal(branch, "main"); runGitFixture(root, ["update-ref", "refs/remotes/origin/main", X]); };
    assert.equal((await extend(root, M, { fetchBaseBranch })).action, "chain_extended");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing base fetch refuses base_fetch_failed naming git fetch origin and writes nothing", async () => {
  const { root, B } = await capFixture();
  try {
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    let proofCalls = 0;
    const refused = await extend(root, D, { fetchBaseBranch: () => { throw new Error("offline"); }, resolveProof: async () => { proofCalls++; return null; } });
    assert.equal(refused.reason, "base_fetch_failed");
    assert.equal(proofCalls, 0, "the proof reads origin/<base>, so it never runs before the fetch");
    assert.match(refused.detail, /git -C \S+ fetch origin main/);
    assert.equal(refused.recovery, `git -C ${shellQuote(path.resolve(root))} fetch origin main`);
    assert.equal(readSealedGateDeltaRecord(path.join(root, "tmp"), B), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pr_state_unreadable names the gh auth remedy", async () => {
  const { root } = await capFixture();
  try {
    const refused = await extend(root, "", { fetchPr: async () => ({}) });
    assert.equal(refused.reason, "pr_state_unreadable");
    assert.match(refused.detail, /gh auth status.*--repo owner\/repo --pr 70/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-clearing or unsealed record at the chain end refuses record_not_clearing and keeps its bytes (a clearing one moves the chain end; the race test covers record_exists)", async () => {
  const { root, B } = await capFixture();
  try {
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, B, { reviewBaselineHead: B, candidateHead: "f".repeat(40), outcome: "needs_fix", nextStep: "fix", items: [] });
    const before = readSealedGateDeltaRecord(tmp, B);
    const refused = await extend(root, D);
    assert.equal(refused.reason, "record_not_clearing");
    assert.match(refused.recovery, /loop pre-push-delta --reviewer-only --repo \S+ --pr \d+ --baseline /u);
    assert.doesNotMatch(refused.detail, /extend-cap-round-chain|gate-coordination/);
    assert.match(refused.detail, /loop pre-push-delta --reviewer-only --repo \S+ --pr \d+ --baseline/);
    // RECOVERY-COMMAND-REQUIRED: the printed command is the recovery field's command, resolved worktree included (issue 3443 round 4).
    assert.ok(refused.detail.includes(`--worktree ${shellQuote(path.resolve(root))} (then --result`), refused.detail);
    assert.ok(refused.recovery.endsWith(`--worktree ${shellQuote(path.resolve(root))}`), refused.recovery);
    assert.doesNotMatch(refused.detail, /rm -f/);
    assert.deepEqual(readSealedGateDeltaRecord(tmp, B), before);
    rmSync(path.join(tmp, "gate-delta", `${B}.json.seal`));
    assert.equal((await extend(root, D)).reason, "record_not_clearing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a record that lands between the read and the write is not overwritten", async () => {
  const { root, B } = await capFixture();
  try {
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const tmp = path.join(root, "tmp");
    const other = { reviewBaselineHead: B, candidateHead: "f".repeat(40), outcome: "bounded_out", nextStep: "push_to_gate", items: [] };
    const writeRecord = (tmpRoot, end, record, opts) => { writeSealedGateDeltaRecord(tmpRoot, end, other); return writeSealedGateDeltaRecord(tmpRoot, end, record, opts); };
    assert.equal((await extend(root, D, { writeRecord })).reason, "record_exists");
    assert.deepEqual(readSealedGateDeltaRecord(tmp, B), other);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed or throwing post-write proof removes the record and its seal", async () => {
  const { root, B } = await capFixture();
  try {
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const tmp = path.join(root, "tmp");
    const recordPath = path.join(tmp, "gate-delta", `${B}.json`);
    const refused = await extend(root, D, { resolveProof: async () => null });
    assert.equal(refused.reason, "proof_not_reached");
    assert.equal(existsSync(recordPath) || existsSync(`${recordPath}.seal`), false);
    let calls = 0;
    await assert.rejects(extend(root, D, { resolveProof: async (...a) => { if (calls++ === 0) return resolveCapRoundFixed(...a); throw new Error("ledger read"); } }), /ledger read/);
    assert.equal(existsSync(recordPath) || existsSync(`${recordPath}.seal`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the rollback leaves a record another writer replaced", async () => {
  const { root, B } = await capFixture();
  try {
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const tmp = path.join(root, "tmp");
    const other = { reviewBaselineHead: B, candidateHead: "f".repeat(40), outcome: "bounded_out", nextStep: "push_to_gate", items: [] };
    let calls = 0;
    const resolveProof = async () => { if (calls++ > 0) writeSealedGateDeltaRecord(tmp, B, other); return null; };
    const refused = await extend(root, D, { resolveProof });
    assert.equal(refused.reason, "proof_not_reached");
    assert.match(refused.detail, /changed since this run wrote it/);
    assert.deepEqual(readSealedGateDeltaRecord(tmp, B), other);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the latest ancestor chain end is chosen when a merge-seeded chain follows the direct one", async () => {
  const { root, A, B } = await capFixture();
  try {
    runGitFixture(root, ["checkout", "-q", "-b", "base-side", A]);
    const X = await commit(root, { "src/base.mjs": "export const base = 1;\n" }, "base logic");
    runGitFixture(root, ["update-ref", "refs/remotes/origin/main", X]);
    runGitFixture(root, ["checkout", "-q", B]);
    runGitFixture(root, ["merge", "-q", "--no-ff", "-m", "merge base", X]);
    const M = gitSha(root);
    const C = await commit(root, { "src/a.mjs": "export const a = 3;\n" }, "fixer 2");
    writeSealedGateDeltaRecord(path.join(root, "tmp"), M, { reviewBaselineHead: M, candidateHead: C, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const result = await extend(root, D);
    assert.equal(result.action, "chain_extended", JSON.stringify(result));
    assert.equal(result.chainEnd, C);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--worktree accepts a path in both forms and may be omitted; a blank value is a parse error", () => {
  const base = ["--repo", "o/n", "--pr", "1"];
  assert.equal(parseExtendCapRoundChainCliArgs([...base, "--worktree", "/abs/path"]).worktree, "/abs/path");
  assert.equal(parseExtendCapRoundChainCliArgs([...base, "--worktree=/abs/path"]).worktree, "/abs/path");
  assert.equal(parseExtendCapRoundChainCliArgs(base).worktree, undefined);
  for (const blank of [["--worktree", ""], ["--worktree", "   "], ["--worktree= "]]) {
    assert.throws(() => parseExtendCapRoundChainCliArgs([...base, ...blank]), /worktree/);
  }
});

test("a --repo that differs from the checkout origin refuses repo_mismatch and writes no record", async () => {
  const { root, B } = await capFixture();
  try {
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    for (const origin of ["owner/other", "Owner/Repo-x", null]) {
      const result = await extend(root, D, { detectOriginSlug: () => origin, fetchPr: async () => { throw new Error("fetchPr must not run"); } });
      assert.equal(result.reason, "repo_mismatch");
      // No `<origin slug>` placeholder: an unresolved origin names the operator action.
      if (origin) assert.ok(result.recovery.endsWith(`gate extend-cap-round-chain --repo ${origin} --pr ${PR} --worktree ${shellQuote(path.resolve(root))}`));
      else assert.equal(result.recovery, `operator: run from a clone whose origin is ${REPO}, then rerun`);
    }
    // repoSlugEquals normalization: a case variant of --repo is accepted and the origin slug keys the ledger path.
    const variant = await extendCapRoundChain({ repo: "Owner/Repo", pr: PR, worktree: root }, { detectOriginSlug: () => REPO, fetchPr: async () => ({ headRefOid: D, baseRefName: "main" }), fetchBaseBranch: () => {} });
    assert.equal(variant.action, "chain_extended");
    assert.ok(readSealedGateDeltaRecord(path.join(root, "tmp"), B));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing seal write in the exclusive path removes the linked record and rethrows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "seal-fail-"));
  try {
    const sha = "a".repeat(40);
    const recordPath = gateDeltaRecordPath(root, sha);
    await mkdir(`${recordPath}.seal`, { recursive: true }); // a directory at the seal path makes the seal removal throw
    assert.throws(() => writeSealedGateDeltaRecord(root, sha, { reviewBaselineHead: sha }, { exclusive: true }));
    assert.equal(existsSync(recordPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Clean cap round at A (no fixer pass, no record), the checkout at A. */
async function cleanCapFixture() {
  const { root, A } = await capFixture();
  const dir = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`);
  await writeFile(path.join(dir, `draft_gate-${A}.json`), JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", headSha: A, verdict: "clean", loggedAt: "2026-11-04T00:00:00.000Z", findings: [] }), "utf8");
  const recordPath = gateDeltaRecordPath(path.join(root, "tmp"), A);
  rmSync(recordPath, { force: true });
  rmSync(`${recordPath}.seal`, { force: true });
  runGitFixture(root, ["checkout", "-q", A]);
  return { root, A };
}

test("a clean cap round plus a docs-only commit seals a record bound to the cap-round head (PR 3078 replay)", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const D = await commit(root, { "docs/decisions/0001-x.md": "# x\n" }, "adr");
    assert.equal(await proof(root, D), null, "before the extension the proof is null");
    const result = await extend(root, D);
    assert.deepEqual({ ...result }, { ok: true, action: "chain_extended", chainEnd: A, candidateHead: D, files: ["docs/decisions/0001-x.md"] });
    assert.ok(await proof(root, D), "the resolveCapRoundFixed seam ready-for-review calls reaches the head");
    const record = readSealedGateDeltaRecord(path.join(root, "tmp"), A);
    assert.equal(record.extension, "docs_tests_only");
    assert.equal(record.outcome, "locally_clear");
    assert.deepEqual(record.items, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean cap round plus a logic commit refuses logic_commit_in_range and writes no record", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/b.mjs": "export const b = 1;\n" }, "logic");
    const refused = await extend(root, L);
    assert.equal(refused.reason, "logic_commit_in_range");
    assert.doesNotMatch(refused.detail, /act list and fixer files/u);
    assert.match(refused.detail, /reviewer-only --repo \S+ --pr \d+ --baseline/u);
    assert.ok(refused.detail.includes(`--findings-log ${path.join(realpathSync(root), "tmp", "gate-findings", "owner-repo", `pr-${PR}`, `draft_gate-${A}.json`)}`), "the remedy prints the resolved cap-round ledger path");
    const recordPath = gateDeltaRecordPath(path.join(root, "tmp"), A);
    assert.equal(existsSync(recordPath), false);
    assert.equal(existsSync(`${recordPath}.seal`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean cap round at the PR head writes no record, and an orphaned cap-round head still refuses baseline_orphaned", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    // The cap round resolves at the PR head (ADR 0265): the clean draft_gate verdict path applies, nothing is written, and the tool refuses no_cap_round_chain because the cap-round head is not a strict ancestor of the head.
    const clean = await extend(root, A);
    assert.equal(clean.reason, "no_cap_round_chain");
    assert.match(clean.detail, /no covering sealed cap-round clearing chain/);
    assert.equal(existsSync(gateDeltaRecordPath(path.join(root, "tmp"), A)), false);
    runGitFixture(root, ["checkout", "-q", "--orphan", "rebased"]);
    const R = await commit(root, { "docs/r.md": "r\n" }, "rebased");
    assert.equal((await extend(root, R)).reason, "baseline_orphaned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean cap-round ledger that holds an open act finding still refuses no_cap_round_chain and writes no record", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const act = { severity: "medium", summary: "guard missing", files: ["src/a.mjs"], line: 1, judgeDisposition: "act", judgeTitle: "Guard", judgeFix: "add" };
    const ledger = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`, `draft_gate-${A}.json`);
    await writeFile(ledger, JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", headSha: A, verdict: "clean", loggedAt: "2026-11-04T00:00:00.000Z", findings: [act] }), "utf8");
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    assert.equal((await extend(root, D)).reason, "no_cap_round_chain");
    assert.equal(existsSync(gateDeltaRecordPath(path.join(root, "tmp"), A)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean cap round with a delta record over a logic commit that does not reach the head refuses delta_range_mismatch (ADR 0254)", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const B = String(runGitFixture(root, ["rev-list", "--max-count=1", "--all", `^${A}`])).trim();
    assert.ok(B, "the fixer commit B exists after A and changes src/a.mjs");
    writeSealedGateDeltaRecord(path.join(root, "tmp"), A, { reviewBaselineHead: A, candidateHead: B, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    runGitFixture(root, ["checkout", "-q", B]);
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    assert.equal(await proof(root, D), null, "the plain record alone does not prove the clean cap round");
    assert.equal((await extend(root, D)).reason, "delta_range_mismatch");
    assert.equal(await proof(root, D), null);
    assert.equal(readSealedGateDeltaRecord(path.join(root, "tmp"), A).extension, undefined, "the plain record at the cap-round head is never overwritten");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean cap round with a plain record over docs commits only seals the extension at the chain end (ADR 0250)", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const B = await commit(root, { "docs/b.md": "b\n" }, "docs b");
    writeSealedGateDeltaRecord(path.join(root, "tmp"), A, { reviewBaselineHead: A, candidateHead: B, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs d");
    assert.equal(await proof(root, D), null, "the plain record alone does not prove the clean cap round");
    const result = await extend(root, D);
    assert.deepEqual({ ...result }, { ok: true, action: "chain_extended", chainEnd: B, candidateHead: D, files: result.files });
    assert.deepEqual([...result.files].sort(), ["docs/b.md", "docs/d.md"]);
    assert.ok(await proof(root, D));
    assert.equal(readSealedGateDeltaRecord(path.join(root, "tmp"), A).extension, undefined, "the plain record at the cap-round head is never overwritten");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean cap round holding only a capClosed reject finding plus a docs-only commit seals at the cap-round head", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const nit = { severity: "low", summary: "nit", files: ["src/a.mjs"], line: 1, judgeDisposition: "reject", judgeTitle: "Nit", capClosed: true };
    const ledger = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`, `draft_gate-${A}.json`);
    await writeFile(ledger, JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", headSha: A, verdict: "clean", loggedAt: "2026-11-04T00:00:00.000Z", findings: [nit] }), "utf8");
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const result = await extend(root, D);
    assert.deepEqual({ ...result }, { ok: true, action: "chain_extended", chainEnd: A, candidateHead: D, files: ["docs/d.md"] });
    assert.ok(await proof(root, D));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean-verdict cap round whose act item a sealed fixer record resolved extends at the fixer chain end, not the cap-round head", async () => {
  const { root, A, B } = await capFixture();
  try {
    const act = { severity: "medium", summary: "guard missing", files: ["src/a.mjs"], line: 1, judgeDisposition: "act", judgeTitle: "Guard", judgeFix: "add" };
    const ledger = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`, `draft_gate-${A}.json`);
    await writeFile(ledger, JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", headSha: A, verdict: "clean", loggedAt: "2026-11-04T00:00:00.000Z", findings: [act] }), "utf8");
    const recordPath = gateDeltaRecordPath(path.join(root, "tmp"), A);
    rmSync(recordPath, { force: true });
    rmSync(`${recordPath}.seal`, { force: true });
    writeSealedGateDeltaRecord(path.join(root, "tmp"), A, { reviewBaselineHead: A, candidateHead: B, outcome: "locally_clear", nextStep: "push_to_gate", items: [{ ref: fingerprintFinding(act), status: "resolved" }] });
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const result = await extend(root, D);
    assert.deepEqual({ ...result }, { ok: true, action: "chain_extended", chainEnd: B, candidateHead: D, files: ["docs/d.md"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mixed cap round (one code item, one PR-body item) is fixed by a sealed record that names only the code ref", async () => {
  const { root, A, B } = await capFixture();
  try {
    const code = { severity: "medium", summary: "guard missing", files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: "Guard", judgeFix: "add" };
    const body = { severity: "low", summary: "body gap", angle: "spec", judgeDisposition: "act", judgeTitle: "Body" };
    const ledger = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`, `draft_gate-${A}.json`);
    await writeFile(ledger, JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", headSha: A, verdict: "findings_present", loggedAt: "2026-11-04T00:00:00.000Z", findings: [code, body] }), "utf8");
    const recordPath = gateDeltaRecordPath(path.join(root, "tmp"), A);
    rmSync(recordPath, { force: true });
    rmSync(`${recordPath}.seal`, { force: true });
    writeSealedGateDeltaRecord(path.join(root, "tmp"), A, { reviewBaselineHead: A, candidateHead: B, outcome: "locally_clear", nextStep: "push_to_gate", items: [{ ref: fingerprintFinding(code), status: "resolved" }] });
    assert.ok(await proof(root, B), "the body ref is not required in the record");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean cap round whose plain clearing chain ends at the PR head refuses chain_reaches_head and writes nothing", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    writeSealedGateDeltaRecord(path.join(root, "tmp"), A, { reviewBaselineHead: A, candidateHead: D, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const result = await extend(root, D);
    assert.equal(result.reason, "chain_reaches_head");
    assert.match(result.detail, /further docs or tests commit/u);
    // RECOVERY-COMMAND-REQUIRED: a rerun at the unchanged head refuses again, so the recovery names the head-moving commit and is never the bare rerun.
    assert.match(result.recovery, /^operator: push one docs or tests commit to the PR branch, then rerun /u);
    assert.notEqual(result.recovery, `node <dev-loops-package-root>/cli/index.mjs gate extend-cap-round-chain --repo ${REPO} --pr ${PR}`);
    assert.equal(readSealedGateDeltaRecord(path.join(root, "tmp"), A).extension, undefined);
    assert.equal(existsSync(gateDeltaRecordPath(path.join(root, "tmp"), D)), false);
    // The exit the remedy names: one further docs commit moves the head past the chain end, and the extension binds there.
    const E = await commit(root, { "docs/e.md": "e\n" }, "docs e");
    const next = await extend(root, E);
    assert.equal(next.action, "chain_extended");
    assert.equal(next.chainEnd, D);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean cap round whose sealed locally_clear delta covers exactly the cap-round head to the PR head over a logic commit seals delta_covered (ADR 0254, issue 3049 AC2)", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs d");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: D, outcome: "locally_clear", nextStep: "push_to_gate", items: [{ ref: "t1", status: "resolved" }] });
    assert.equal(await proof(root, D), null, "the plain delta record alone does not prove a clean cap round");
    const result = await extend(root, D);
    assert.deepEqual({ ...result, files: [...result.files].sort() }, { ok: true, action: "chain_extended", chainEnd: A, candidateHead: D, files: ["docs/d.md", "src/x.mjs"] });
    const record = readSealedGateDeltaRecord(tmp, A);
    assert.equal(record.extension, "delta_covered");
    assert.deepEqual(record.items, [{ ref: "t1", status: "resolved" }], "the delta's own fields are kept");
    assert.ok(await proof(root, D));
    assert.equal((await extend(root, D)).action, "already_proven");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a code commit pushed after the covering delta refuses delta_range_mismatch and leaves the record untouched (issue 3049 AC3)", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const M = await commit(root, { "src/y.mjs": "export const y = 1;\n" }, "logic M");
    const result = await extend(root, M);
    assert.equal(result.reason, "delta_range_mismatch");
    assert.match(result.recovery, new RegExp(`loop pre-push-delta --reviewer-only .*--baseline ${A} --pr-head ${M}`, "u"));
    assert.match(result.detail, /reviewer-only pre-push delta over .*--reviewer-only --repo \S+ --pr \d+ --baseline .*--pr-head.*replacement PR/u);
    assert.equal(readSealedGateDeltaRecord(tmp, A).extension, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a record already sealed delta_covered for the head refuses proof_not_reached, not delta_range_mismatch, and keeps its bytes", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [], extension: "delta_covered" });
    const before = readFileSync(gateDeltaRecordPath(tmp, A), "utf8");
    const refused = await extend(root, L, { resolveProof: async () => null });
    assert.equal(refused.reason, "proof_not_reached");
    assert.match(refused.detail, /already carries delta_covered/u);
    assert.equal(readFileSync(gateDeltaRecordPath(tmp, A), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a record already sealed with another extension for the head refuses proof_not_reached, not a contradictory delta_range_mismatch", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [], extension: "docs_tests_only" });
    const before = readFileSync(gateDeltaRecordPath(tmp, A), "utf8");
    const refused = await extend(root, L, { resolveProof: async () => null });
    assert.equal(refused.reason, "proof_not_reached");
    assert.match(refused.detail, /already carries docs_tests_only/u);
    assert.equal(readFileSync(gateDeltaRecordPath(tmp, A), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a delta that reaches the head but is not locally_clear refuses delta_range_mismatch (bounded_out is no cover)", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "bounded_out", nextStep: "push", items: [] });
    assert.equal((await extend(root, L)).reason, "delta_range_mismatch");
    assert.equal(readSealedGateDeltaRecord(tmp, A).extension, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bounded_out A to L record over logic plus a locally_clear L to D record never seals: the later link does not clear L (forged chain)", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs d");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "bounded_out", nextStep: "push_to_gate", items: [] });
    writeSealedGateDeltaRecord(tmp, L, { reviewBaselineHead: L, candidateHead: D, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const result = await extend(root, D);
    assert.equal(result.reason, "delta_range_mismatch");
    assert.match(result.recovery, new RegExp(`loop pre-push-delta --reviewer-only .*--baseline ${A} --pr-head ${D}`, "u"));
    assert.match(result.detail, /outcome bounded_out/u, "names the failing link's outcome");
    assert.equal(readSealedGateDeltaRecord(tmp, A).extension, undefined);
    assert.equal(readSealedGateDeltaRecord(tmp, L).extension, undefined);
    assert.equal(await proof(root, D), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed proof after sealing delta_covered leaves a record another writer replaced", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const result = await extend(root, L, { resolveProof: async () => { writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [{ ref: "other", status: "resolved" }] }); return null; } });
    assert.equal(result.reason, "proof_not_reached");
    assert.match(result.detail, /left in place/u);
    assert.deepEqual(readSealedGateDeltaRecord(tmp, A).items, [{ ref: "other", status: "resolved" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed proof after sealing delta_covered does not recreate a record another writer removed", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const recordPath = gateDeltaRecordPath(tmp, A);
    let calls = 0;
    const result = await extend(root, L, { resolveProof: async () => { if (calls++ > 0) { rmSync(recordPath, { force: true }); rmSync(`${recordPath}.seal`, { force: true }); } return null; } });
    assert.equal(result.reason, "proof_not_reached");
    assert.match(result.detail, /left in place/u);
    assert.equal(existsSync(recordPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed read right after the write does not stop the restore of the record this run wrote", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const recordPath = gateDeltaRecordPath(tmp, A);
    const before = [readFileSync(recordPath, "utf8"), readFileSync(`${recordPath}.seal`, "utf8")];
    let afterWrite = false;
    const result = await extend(root, L, {
      writeRecord: (...a) => { writeSealedGateDeltaRecord(...a); afterWrite = true; },
      resolveProof: async () => { afterWrite = false; return null; },
      readRecord: (...a) => { if (afterWrite) throw new Error("read failed between write and proof"); return readGateDeltaRecord(...a); },
    });
    assert.equal(result.reason, "proof_not_reached");
    assert.match(result.detail, /was restored/u);
    assert.deepEqual([readFileSync(recordPath, "utf8"), readFileSync(`${recordPath}.seal`, "utf8")], before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed proof after sealing delta_covered restores the delta record byte for byte", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const recordPath = gateDeltaRecordPath(tmp, A);
    const bytes = () => [readFileSync(recordPath, "utf8"), readFileSync(`${recordPath}.seal`, "utf8")];
    const before = bytes();
    const result = await extend(root, L, { resolveProof: async () => null });
    assert.equal(result.reason, "proof_not_reached");
    assert.deepEqual(bytes(), before, "the record and seal bytes are restored");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("a clean cap round with no record at the cap-round head and a base-only-merge chain ending at the head still extends at the cap-round head", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    runGitFixture(root, ["checkout", "-q", "-b", "base-side", A]);
    const X = await commit(root, { "src/base.mjs": "export const base = 1;\n" }, "base logic");
    runGitFixture(root, ["update-ref", "refs/remotes/origin/main", X]);
    runGitFixture(root, ["checkout", "-q", A]);
    runGitFixture(root, ["merge", "-q", "--no-ff", "-m", "merge base", X]);
    const M = String(runGitFixture(root, ["rev-parse", "HEAD"])).trim();
    const N = await commit(root, { "docs/d.md": "d\n" }, "docs");
    writeSealedGateDeltaRecord(path.join(root, "tmp"), M, { reviewBaselineHead: M, candidateHead: N, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    assert.equal(existsSync(gateDeltaRecordPath(path.join(root, "tmp"), A)), false);
    const result = await extend(root, N);
    assert.equal(result.action, "chain_extended");
    assert.equal(result.chainEnd, A);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a throwing proof after sealing delta_covered rethrows and restores the record", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const recordPath = gateDeltaRecordPath(tmp, A);
    const before = readFileSync(recordPath, "utf8");
    let calls = 0;
    await assert.rejects(extend(root, L, { resolveProof: async (...a) => { if (calls++ === 0) return resolveCapRoundFixed(...a); throw new Error("ledger read"); } }), /ledger read/);
    assert.equal(readSealedGateDeltaRecord(tmp, A).extension, undefined);
    assert.equal(readFileSync(recordPath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a docs commit after a delta_covered seal extends at the end of the covered range", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs d");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: D, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    assert.equal((await extend(root, D)).action, "chain_extended");
    const E = await commit(root, { "docs/e.md": "e\n" }, "docs e");
    const result = await extend(root, E);
    assert.deepEqual({ ...result }, { ok: true, action: "chain_extended", chainEnd: D, candidateHead: E, files: ["docs/e.md"] });
    assert.ok(await proof(root, E));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cleared end inside a cyclic chain still seals the covering delta through the main logic path", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const X = await commit(root, { "docs/x.md": "x\n" }, "docs x");
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    const clear = { outcome: "locally_clear", nextStep: "push_to_gate", items: [] };
    // A cleared X (docs_tests_only); the delta X..L covers the head; L..A closes a cycle, so the walk has no end and neither the chain-reaches-head branch nor an ancestor end applies.
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: X, ...clear, extension: "docs_tests_only" });
    writeSealedGateDeltaRecord(tmp, X, { reviewBaselineHead: X, candidateHead: L, ...clear });
    writeSealedGateDeltaRecord(tmp, L, { reviewBaselineHead: L, candidateHead: A, ...clear });
    let calls = 0;
    const result = await extend(root, L, { resolveProof: async () => (calls++ === 0 ? null : {}) });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(readSealedGateDeltaRecord(tmp, X).extension, "delta_covered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a logic commit after a delta_covered seal and a docs extension refuses with the chain end as the delta baseline, then the delta at the chain end reaches the head", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs d");
    const tmp = path.join(root, "tmp");
    const clear = { outcome: "locally_clear", nextStep: "push_to_gate", items: [] };
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: D, ...clear });
    assert.equal((await extend(root, D)).action, "chain_extended");
    const E = await commit(root, { "docs/e.md": "e\n" }, "docs e");
    assert.equal((await extend(root, E)).action, "chain_extended");
    const F = await commit(root, { "src/f.mjs": "export const f = 1;\n" }, "logic F");
    const refused = await extend(root, F);
    assert.equal(refused.ok, false);
    assert.ok(refused.detail.includes(`over ${E.slice(0, 7)}..`), refused.detail);
    writeSealedGateDeltaRecord(tmp, E, { reviewBaselineHead: E, candidateHead: F, ...clear });
    // The delta at the chain end E extends the chain A..D..E, so the proof reaches F without a further seal.
    const ok = await extend(root, F);
    assert.equal(ok.action, "already_proven", JSON.stringify(ok));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-clean fixer chain: a plain chain-end delta is already proven, one with an off-history candidate refuses", async () => {
  const { root, A, B } = await capFixture();
  try {
    runGitFixture(root, ["checkout", "-q", "-b", "side", B]);
    const S = await commit(root, { "src/s.mjs": "export const s = 1;\n" }, "side logic");
    runGitFixture(root, ["checkout", "-q", B]);
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, B, { reviewBaselineHead: B, candidateHead: S, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    // A record at the chain end whose candidate is not on the head's history leaves no ancestor chain end: the delta covers nothing here.
    const refused = await extend(root, L);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "no_cap_round_chain");
    writeSealedGateDeltaRecord(tmp, B, { reviewBaselineHead: B, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const ok = await extend(root, L);
    assert.equal(ok.action, "already_proven", JSON.stringify(ok));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a delta record that changed on disk after validation is never overwritten", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const recordPath = gateDeltaRecordPath(tmp, A);
    const before = readFileSync(recordPath, "utf8");
    let writes = 0;
    const result = await extend(root, L, {
      readRecord: (...a) => ({ ...JSON.parse(readFileSync(gateDeltaRecordPath(a[0], a[1]), "utf8")), outcome: "bounded_out" }),
      writeRecord: () => { writes += 1; },
    });
    assert.equal(result.reason, "record_changed");
    assert.equal(writes, 0);
    assert.equal(readFileSync(recordPath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sealing delta_covered reads and writes the record while the sequence lock directory exists", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const before = readFileSync(gateDeltaRecordPath(tmp, A), "utf8");
    // The read and write seams record whether the sequence lock directory exists at the call.
    const lockDir = `${gateDeltaRecordPath(tmp, A)}`.replace(/\.json$/, ".sequence-lock");
    const held = [];
    const result = await extend(root, L, {
      readRecord: (...a) => { held.push(["read", existsSync(lockDir)]); return readGateDeltaRecord(...a); },
      writeRecord: (...a) => { held.push(["write", existsSync(lockDir)]); writeSealedGateDeltaRecord(...a); },
    });
    assert.equal(result.action, "chain_extended");
    assert.ok(held.some(([kind]) => kind === "write"), "the seal wrote a record");
    assert.deepEqual(held.filter(([, isHeld]) => !isHeld), [], "every read and write runs under the sequence lock");
    assert.notEqual(readFileSync(gateDeltaRecordPath(tmp, A), "utf8"), before, "the seal wrote the extension");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ADR 0255 decision 9: one sequence lock spans seal, proof and restore on both paths; a contender never gets between them.
const busy = (tmp, baseline) => withSequenceLock(tmp, [baseline], () => "acquired", { waitMs: 60 }).catch((error) => error.code);

test("the delta_covered seal holds the sequence lock through the proof and its restore", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: L, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    let duringProof;
    const result = await extend(root, L, { resolveProof: async () => { duringProof = await busy(tmp, A); return null; } });
    assert.equal(result.reason, "proof_not_reached");
    assert.equal(duringProof, "SEQUENCE_LOCK_BUSY", "the lock is held while the proof runs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the docs_tests_only create writes while the sequence lock directory exists and holds the lock through the proof and its rollback", async () => {
  const { root, B } = await capFixture();
  try {
    const D = await commit(root, { "docs/decisions/0001-x.md": "# x\n" }, "docs");
    const tmp = path.join(root, "tmp");
    const lockDir = gateDeltaRecordPath(tmp, B).replace(/\.json$/, ".sequence-lock");
    const held = [];
    const created = await extend(root, D, { writeRecord: (...a) => { held.push(existsSync(lockDir)); writeSealedGateDeltaRecord(...a); } });
    assert.equal(created.action, "chain_extended");
    assert.deepEqual(held, [true], "the exclusive create runs under the sequence lock");
    rmSync(gateDeltaRecordPath(tmp, B), { force: true });
    rmSync(`${gateDeltaRecordPath(tmp, B)}.seal`, { force: true });
    let duringProof;
    const refused = await extend(root, D, { resolveProof: async () => { duringProof = await busy(tmp, B); return null; } });
    assert.equal(refused.reason, "proof_not_reached");
    assert.equal(duringProof, "SEQUENCE_LOCK_BUSY", "the lock is held while the proof runs");
    assert.equal(existsSync(gateDeltaRecordPath(tmp, B)), false, "the rollback removed the record");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean ledger at the PR head resolves no cap round and writes nothing", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const result = await extend(root, A);
    assert.equal(result.reason, "no_cap_round_chain");
    assert.match(result.detail, /has no covering sealed cap-round clearing chain/u);
    assert.match(result.detail, /no extension is needed/u);
    assert.equal(readSealedGateDeltaRecord(path.join(root, "tmp"), A), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every copy of the start-of-logic-range definition carries the one canonical clause", () => {
  const clause = "the cap-round head for a clean cap round whose cap-head record is absent or carries no extension, the end of the extended chain when it carries one, and otherwise the chain end";
  const files = ["scripts/loop/extend-cap-round-chain.mjs", "packages/core/src/loop/pr-gate-coordination.mjs", "skills/docs/gate-review-sub-loop-contract.md", ".claude/skills/docs/gate-review-sub-loop-contract.md", "docs/decisions/0254-cap-chain-delta-extension.md"];
  for (const file of files) {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.ok(text.includes(clause), file);
    for (const old of ["candidate head of an already-extended cap-head record", "(the end of the extended chain)", "or the candidate head"]) assert.ok(!text.includes(old), `${file}: ${old}`);
  }
  const count = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").split(clause).length - 1;
  assert.equal(count("scripts/loop/extend-cap-round-chain.mjs"), 2);
  assert.equal(count("packages/core/src/loop/pr-gate-coordination.mjs"), 3);
  assert.equal(count("docs/decisions/0254-cap-chain-delta-extension.md"), 2);
  assert.equal(count("skills/docs/gate-review-sub-loop-contract.md"), 1);
  assert.equal(count(".claude/skills/docs/gate-review-sub-loop-contract.md"), 1);
});

// Produces the record with the reviewer-only CLI (ADR 0255, issue 3122): the input run, a sealed result that marks every derived act item with `status`, then the result run.
// The findings log is the cap-round ledger at the baseline plus the provenance the delta input authenticates.
async function reviewerOnlyDelta(root, baseline, head, { status = "resolved", logHead = baseline, cover = false } = {}) {
  const tmp = path.join(root, "tmp");
  const seam = { stdout: { write: () => {} }, fetchBase: () => {}, fetchPr: async () => ({ baseRefName: "main" }) };
  const logPath = path.join(tmp, "gate-findings", "owner-repo", `pr-${PR}`, `draft_gate-${logHead}.json`); // the canonical ledger: the route refuses any other file
  const ledger = JSON.parse(readFileSync(logPath, "utf8"));
  writeFileSync(logPath, JSON.stringify({ ...ledger, provenance: { perAngle: [{ angle: "correctness" }] } }));
  const args = ["--reviewer-only", ...(cover ? ["--cover-uncovered"] : []), "--repo", ledger.repo, "--pr", String(ledger.pr), "--baseline", baseline, "--pr-head", head, "--findings-log", logPath, "--worktree", root];
  const resultPath = path.join(root, "reviewer-result.json");
  const { input } = await runDeltaCli([...args, "--spec-identity", "spec@1", "--result-path", resultPath], seam);
  const actionableItems = input.actItems.map((item) => ({ ref: item.ref, status, evidence: ["src/x.mjs:1"] }));
  writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems, newFindings: [], widenedReads: [], outcome: status === "resolved" ? "locally_clear" : "needs_fix" }));
  sealDeltaFixture(tmp, resultPath);
  await runDeltaCli([...args, "--result", resultPath, "--invocation", "1"], seam);
  return tmp;
}

// A logic commit L after `from`, then a base-refresh merge: the PR 3087 shape.
async function logicThenBaseRefresh(root, from) {
  const L = await commit(root, { "src/x.mjs": "export const x = 1;\n" }, "logic L");
  runGitFixture(root, ["checkout", "-q", "-b", "base-moves", from]);
  const X = await commit(root, { "refreshed.txt": "from the base\n" }, "base moves");
  runGitFixture(root, ["update-ref", "refs/remotes/origin/main", X]);
  runGitFixture(root, ["checkout", "-q", L]);
  runGitFixture(root, ["merge", "-q", "--no-ff", "-m", "refresh base", "base-moves"]);
  return String(runGitFixture(root, ["rev-parse", "HEAD"])).trim();
}

test("a clean cap round: a record from the reviewer-only CLI covers a logic commit and a base-refresh merge and seals delta_covered (ADR 0255, issue 3122 AC2)", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const head = await logicThenBaseRefresh(root, A);
    const tmp = await reviewerOnlyDelta(root, A, head);
    const written = readSealedGateDeltaRecord(tmp, A);
    assert.deepEqual({ o: written.outcome, i: written.items, c: written.candidateHead, n: written.invocation }, { o: "locally_clear", i: [], c: head, n: 1 });
    assert.equal(await proof(root, head), null, "the plain delta record alone does not prove a clean cap round");
    const result = await extend(root, head);
    assert.deepEqual({ ...result, files: [...result.files].sort() }, { ok: true, action: "chain_extended", chainEnd: A, candidateHead: head, files: ["src/x.mjs"] });
    assert.equal(readSealedGateDeltaRecord(tmp, A).extension, "delta_covered");
    assert.ok(await proof(root, head));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// PR 3087 exactly: a findings_present cap round at A with an open act item, a closed sequence (no marker, no plan, no record), then a logic commit and a base-refresh merge.
async function actCapFixture() {
  const act = { severity: "medium", summary: "guard missing", files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: "Guard", judgeFix: "add" };
  const { root, A } = await capFixture({ findings: [act] });
  const recordPath = gateDeltaRecordPath(path.join(root, "tmp"), A);
  rmSync(recordPath, { force: true });
  rmSync(`${recordPath}.seal`, { force: true });
  runGitFixture(root, ["checkout", "-q", A]);
  return { root, A, act };
}

test("a non-clean cap round (open act item, PR 3087): the reviewer-only record carries the derived act refs, so extend-cap-round-chain reaches the head (issue 3122 AC1)", async () => {
  const { root, A, act } = await actCapFixture();
  try {
    const head = await logicThenBaseRefresh(root, A);
    assert.equal(await proof(root, head), null);
    const tmp = await reviewerOnlyDelta(root, A, head);
    const record = readSealedGateDeltaRecord(tmp, A);
    assert.deepEqual({ o: record.outcome, c: record.candidateHead, refs: record.items.map((i) => [i.ref, i.status]) }, { o: "locally_clear", c: head, refs: [[fingerprintFinding(act), "resolved"]] });
    // The record at the cap-round head covers the act ref and reaches the head, so the proof already holds and nothing more is written.
    const result = await extend(root, head);
    assert.equal(result.action, "already_proven");
    assert.ok(await proof(root, head));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-clean cap round: an act item the reviewer does not mark resolved seals no locally_clear record", async () => {
  const { root, A } = await actCapFixture();
  try {
    const head = await logicThenBaseRefresh(root, A);
    const tmp = await reviewerOnlyDelta(root, A, head, { status: "not_resolved" });
    const record = readSealedGateDeltaRecord(tmp, A);
    assert.equal(record.outcome, "needs_fix");
    assert.equal(await proof(root, head), null);
    assert.notEqual((await extend(root, head)).action, "already_proven");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the chain-end remedy is named only for a locally_clear record whose refs the extension route accepts (issue 3124 AC5)", async () => {
  const { root, A, act } = await actCapFixture();
  try {
    const head = await logicThenBaseRefresh(root, A);
    const tmp = path.join(root, "tmp");
    const seal = (items) => writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: head, actSetId: "other", invocation: 1, outcome: "locally_clear", nextStep: "push_to_gate", items });
    const refusal = () => reviewerOnlyDelta(root, A, head).then(() => null, (error) => error.message);
    seal([{ ref: "unrelated", status: "resolved" }]);
    const unrelated = await refusal();
    assert.match(unrelated, /allow-replacement-pr/);
    assert.doesNotMatch(unrelated, /rm -f/);
    assert.doesNotMatch(unrelated, /extend-cap-round-chain/);
    assert.equal((await extend(root, head)).reason, "no_cap_round_chain", "the route the old remedy named would have refused");
    seal([{ ref: fingerprintFinding(act), status: "resolved" }]);
    assert.match(await refusal(), /gate extend-cap-round-chain/);
    assert.equal((await extend(root, head)).ok, true, "the named route accepts the record");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC2: a locally_clear reviewer-only delta over a clean merge that overlaps the base carries the cap-round chain to the merge head", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extend-cap-overlap-"));
  try {
    initGitFixture(root, { commit: null });
    runGitFixture(root, ["config", "commit.gpgsign", "false"]);
    const lines = (top, bottom) => `${top}\n1\n2\n3\n4\n5\n6\n7\n8\n9\n${bottom}\n`;
    const M0 = await commit(root, { ".gitignore": "tmp/\n", "src/f.mjs": lines("top", "bottom") }, "base");
    runGitFixture(root, ["update-ref", "refs/remotes/origin/main", M0]);
    runGitFixture(root, ["checkout", "-q", "-b", "pr"]);
    const A = await commit(root, { "src/f.mjs": lines("top", "pr-bottom") }, "feat: pr");
    runGitFixture(root, ["checkout", "-q", "-b", "base-side", M0]);
    const M1 = await commit(root, { "src/f.mjs": lines("main-top", "bottom") }, "base moves f");
    runGitFixture(root, ["update-ref", "refs/remotes/origin/main", M1]);
    runGitFixture(root, ["checkout", "-q", "pr"]);
    runGitFixture(root, ["merge", "-q", "--no-ff", "-m", "refresh base", M1]);
    const merge = String(runGitFixture(root, ["rev-parse", "HEAD"])).trim();
    const tmp = path.join(root, "tmp");
    const dir = path.join(tmp, "gate-findings", "owner-repo", `pr-${PR}`);
    await mkdir(dir, { recursive: true });
    for (const [i, head] of ["1".repeat(40), "2".repeat(40), "3".repeat(40), A].entries()) {
      await writeFile(path.join(dir, `draft_gate-${head}.json`), JSON.stringify({
        repo: REPO, pr: PR, gate: "draft_gate", headSha: head, verdict: "clean", loggedAt: `2026-11-0${i + 1}T00:00:00.000Z`, findings: [], provenance: { perAngle: [{ angle: "correctness" }] },
      }), "utf8");
    }
    assert.equal(await proof(root, merge), null, "no clearing record yet");
    assert.equal((await extend(root, merge)).reason, "logic_commit_in_range");
    const resultPath = path.join(root, "reviewer-result.json");
    const args = ["--reviewer-only", "--repo", REPO, "--pr", String(PR), "--baseline", A, "--pr-head", merge, "--findings-log", path.join(dir, `draft_gate-${A}.json`), "--worktree", root];
    const seam = { stdout: { write: () => {} }, fetchBase: () => {}, fetchPr: async () => ({ baseRefName: "main" }) };
    const { input } = await runDeltaCli([...args, "--spec-identity", "spec@1", "--result-path", resultPath], seam);
    writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems: [], newFindings: [], widenedReads: [], outcome: "locally_clear" }));
    sealDeltaFixture(tmp, resultPath);
    const decision = await runDeltaCli([...args, "--result", resultPath, "--invocation", "1"], seam);
    assert.equal(decision.outcome, "locally_clear");
    const result = await extend(root, merge);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(await proof(root, merge), "the chain reaches the merge head");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC3: a clean base merge with no overlap keeps the base-only carry and needs no delta", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "extend-cap-no-overlap-"));
  try {
    initGitFixture(root, { commit: null });
    runGitFixture(root, ["config", "commit.gpgsign", "false"]);
    const M0 = await commit(root, { ".gitignore": "tmp/\n", "src/f.mjs": "f\n", "src/g.mjs": "g\n" }, "base");
    runGitFixture(root, ["update-ref", "refs/remotes/origin/main", M0]);
    runGitFixture(root, ["checkout", "-q", "-b", "pr"]);
    const A = await commit(root, { "src/f.mjs": "pr-f\n" }, "feat: pr");
    runGitFixture(root, ["checkout", "-q", "-b", "base-side", M0]);
    const M1 = await commit(root, { "src/g.mjs": "main-g\n" }, "base moves g");
    runGitFixture(root, ["update-ref", "refs/remotes/origin/main", M1]);
    runGitFixture(root, ["checkout", "-q", "pr"]);
    runGitFixture(root, ["merge", "-q", "--no-ff", "-m", "refresh base", M1]);
    const merge = String(runGitFixture(root, ["rev-parse", "HEAD"])).trim();
    const dir = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`);
    await mkdir(dir, { recursive: true });
    for (const [i, head] of ["1".repeat(40), "2".repeat(40), "3".repeat(40), A].entries()) {
      await writeFile(path.join(dir, `draft_gate-${head}.json`), JSON.stringify({
        repo: REPO, pr: PR, gate: "draft_gate", headSha: head, verdict: "clean", loggedAt: `2026-11-0${i + 1}T00:00:00.000Z`, findings: [], provenance: { perAngle: [{ angle: "correctness" }] },
      }), "utf8");
    }
    const result = await extend(root, merge);
    assert.equal(result.action, "chain_extended", JSON.stringify(result));
    assert.ok(await proof(root, merge), "the chain reaches the merge head with no delta record");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3437, PR 3433: the cap-round clear sealed for the round's own act set (candidate B), the fixer's push then failed CI, a base merge and a fix commit moved the head past B.
async function ciFailedCapFixture({ closedRounds = 4 } = {}) {
  const act = { severity: "medium", summary: "guard missing", files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: "Guard", judgeFix: "add" };
  const { root, A, B } = await capFixture({ findings: [act] });
  const tmp = path.join(root, "tmp");
  // capFixture writes four closed rounds (the default cap of 4 resolves a cap round); fewer leave the cap round unclosed.
  for (const n of ["3", "2", "1"].slice(0, 4 - closedRounds)) rmSync(path.join(tmp, "gate-findings", "owner-repo", `pr-${PR}`, `draft_gate-${n.repeat(40)}.json`), { force: true });
  rmSync(gateDeltaRecordPath(tmp, A), { force: true });
  rmSync(`${gateDeltaRecordPath(tmp, A)}.seal`, { force: true });
  writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 3, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(act), status: "resolved" }] });
  const head = await logicThenBaseRefresh(root, B);
  const fix = await commit(root, { "src/y.mjs": "export const y = 1;\n" }, "baseline fix");
  return { root, A, B, head: fix, tmp };
}

test("issue 3437 ac:1: a cap-round clear sealed for the round's own act set covers a head past a CI-failed push, then one reviewer-only delta extends it", async () => {
  const { root, A, B, head, tmp } = await ciFailedCapFixture();
  try {
    assert.equal(await proof(root, head), null);
    const refused = await extend(root, head);
    assert.equal(refused.reason, "logic_commit_in_range", JSON.stringify(refused));
    assert.match(refused.detail, new RegExp(`--baseline ${B}`, "u"), "the delta starts at the sealed candidate, not the cap-round head");
    // ac:3: the reviewer-only run at the cap-round head refuses and names the extension; the extension names a run at the cleared candidate. The two recoveries differ and resolve.
    const deltaRefusal = await reviewerOnlyDelta(root, A, head).then(() => null, (error) => error);
    assert.match(deltaRefusal?.recovery ?? "", /gate extend-cap-round-chain --repo \S+ --pr \S+ --worktree \S+$/u);
    assert.notEqual(deltaRefusal.recovery, refused.recovery);
    assert.match(refused.recovery, new RegExp(`loop pre-push-delta --reviewer-only .*--baseline ${B} --pr-head ${head}`, "u"));
    assert.equal(readGateDeltaRecord(tmp, B), null, "the candidate has no record, so the named run is not refused");
    await reviewerOnlyDelta(root, B, head, { logHead: A });
    const result = await extend(root, head);
    assert.equal(result.ok, true, JSON.stringify(result));
    // The sealed locally_clear record at B reaches the head, so the proof already holds (the chain A to B to head).
    assert.equal(readSealedGateDeltaRecord(tmp, B).candidateHead, head);
    assert.ok(await proof(root, head));
    assert.equal(readSealedGateDeltaRecord(tmp, A).items.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 3437 ac:3: no_cap_round_chain names a replacement PR for a non-covering sealed record at the cap-round head, a run at that head when none exists, and gate-coordination when no cap round resolves", async () => {
  const { root, A, head, tmp } = await ciFailedCapFixture();
  try {
    const { candidateHead: B, items: [{ ref: actRef }] } = readSealedGateDeltaRecord(tmp, A);
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "other", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: "unrelated", status: "resolved" }] });
    const refused = await extend(root, head);
    assert.equal(refused.reason, "no_cap_round_chain");
    // ADR 0255 amendment (issue 3443): a non-covering sealed record at the cap-round head names the cover run first (it never overwrites that record), and the replacement PR as the alternative.
    assert.match(refused.recovery, new RegExp(`loop pre-push-delta --reviewer-only --cover-uncovered .*--baseline ${A} --pr-head ${head}`, "u"));
    assert.ok(refused.detail.includes(CAP_ROUND_REFUSAL.baseline_orphaned), "the replacement PR stays named as the alternative");
    assert.match(refused.detail, /A reviewer-only run with a chain-end baseline derives an empty act list and covers no act ref/u, "the empty-act-list statement is limited to the chain-end reviewer-only run");
    // Issue 3443: the refusal names the records that exist; the act refs they leave uncovered are named too.
    assert.ok(refused.detail.includes(`Uncovered act refs: ${actRef}.`), `names the cap round's own act ref ${actRef}: ${refused.detail}`);
    assert.ok(refused.detail.includes(`Records on the chain: ${A.slice(0, 7)}..${B.slice(0, 7)} [unrelated].`), refused.detail);
    // A covering record whose candidate this clone never fetched (merge-base exit 128) is an unresolved history: the fetch is the recovery, never the replacement PR.
    const missing = "9".repeat(40);
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: missing, actSetId: "other", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: actRef, status: "resolved" }] });
    const unresolved = await extend(root, head);
    assert.equal(unresolved.reason, "history_unresolved", JSON.stringify(unresolved));
    assert.equal(unresolved.recovery, fetchIn(root, missing));
    assert.match(unresolved.detail, /If a commit is still absent after the fetch, restart on a replacement PR/u, "a commit that stays absent has the replacement PR as its next exit (issue 3443 review)");
    // A covering record whose candidate is a real commit off the head's history (merge-base exit 1) gives the replacement PR.
    const sibling = String(runGitFixture(root, ["commit-tree", `${B}^{tree}`, "-p", B, "-m", "abandoned sibling"])).trim();
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: sibling, actSetId: "other", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: actRef, status: "resolved" }] });
    const offHistory = await extend(root, head);
    assert.equal(offHistory.recovery, renderCliText(replacementPrOperatorRecovery(PR)));
    assert.doesNotMatch(offHistory.recovery, /pre-push-delta/u, "a run at the cap-round head refuses and names this command again");
    rmSync(gateDeltaRecordPath(tmp, A), { force: true });
    rmSync(`${gateDeltaRecordPath(tmp, A)}.seal`, { force: true });
    const noRecord = await extend(root, head);
    assert.equal(noRecord.reason, "no_cap_round_chain");
    assert.match(noRecord.recovery, new RegExp(`loop pre-push-delta --reviewer-only .*--baseline ${A} --pr-head ${head}`, "u"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const bare = await mkdtemp(path.join(os.tmpdir(), "extend-cap-chain-"));
  try {
    initGitFixture(bare, { commit: null });
    const refused = await extend(bare, await commit(bare, { "docs/z.md": "z\n" }, "docs"));
    assert.equal(refused.reason, "no_cap_round_chain");
    assert.match(refused.recovery, /loop gate-coordination --repo owner\/repo --pr 70$/u);
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

// Issue 3443 review (ADR 0255 amendment): a partial chain (one of two act refs covered) names the cover run: a chain-end delta seals with empty items and covers no ref, the cover run seals a record keyed by the cap-round head and the ref.
test("issue 3443: a partially covering chain names the cover run, which covers the missing ref and lets the extension reach the head", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    rmSync(gateDeltaRecordPath(tmp, A), { force: true });
    rmSync(`${gateDeltaRecordPath(tmp, A)}.seal`, { force: true });
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 3, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] });
    const head = await commit(root, { "docs/z.md": "z\n" }, "docs");
    const refused = await extend(root, head);
    assert.equal(refused.reason, "no_cap_round_chain", JSON.stringify(refused));
    assert.ok(refused.detail.includes(`Uncovered act refs: ${fingerprintFinding(q)}.`), refused.detail);
    assert.match(refused.recovery, new RegExp(`loop pre-push-delta --reviewer-only --cover-uncovered .*--baseline ${A} --pr-head ${head}`, "u"));
    assert.ok(refused.detail.includes(CAP_ROUND_REFUSAL.baseline_orphaned), "the replacement PR stays named as the alternative");
    // The cover run: the reviewer verifies only the uncovered ref over A..head, with no new commit and without touching the record at A.
    const recordAtA = readFileSync(gateDeltaRecordPath(tmp, A), "utf8");
    await reviewerOnlyDelta(root, A, head, { cover: true });
    assert.equal(readFileSync(gateDeltaRecordPath(tmp, A), "utf8"), recordAtA, "the sealed record at the cap-round head is never overwritten");
    assert.equal(readSealedCoverRecord(tmp, A, fingerprintFinding(q)).status, "resolved");
    const extended = await extend(root, head);
    assert.equal(extended.action, "chain_extended", JSON.stringify(extended));
    assert.equal(extended.chainEnd, B);
    assert.ok(await proof(root, head), "the union (A..B and the cover record) reaches the head");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 review: the tool applies the history bound of resolveCapRoundFixed, so an abandoned sibling link that resolves the missing ref does not count as covering.
test("issue 3443: an off-history sibling link that resolves the missing ref does not make the tool treat the chain as covering", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    rmSync(gateDeltaRecordPath(tmp, A), { force: true });
    rmSync(`${gateDeltaRecordPath(tmp, A)}.seal`, { force: true });
    const C = String(runGitFixture(root, ["commit-tree", `${B}^{tree}`, "-p", B, "-m", "abandoned sibling"])).trim();
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 3, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] });
    writeSealedGateDeltaRecord(tmp, B, { reviewBaselineHead: B, candidateHead: C, actSetId: "round-4", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(q), status: "resolved" }] });
    const head = await commit(root, { "docs/z.md": "z\n" }, "docs");
    const refused = await extend(root, head);
    assert.equal(refused.reason, "no_cap_round_chain", JSON.stringify(refused));
    assert.ok(refused.detail.includes(`Uncovered act refs: ${fingerprintFinding(q)}.`), refused.detail);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 review: the accepting branch of the tool's history bound. A chain covered only by the union (A..B [p], B..C [q]) extends over a later docs commit, because C is on the head's history.
test("issue 3443: a chain covered only by the union of two records extends over a later docs commit", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    const C = await commit(root, { "docs/c.md": "c\n" }, "docs C");
    const head = await commit(root, { "docs/d.md": "d\n" }, "docs D");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] });
    writeSealedGateDeltaRecord(tmp, B, { reviewBaselineHead: B, candidateHead: C, actSetId: "round-4", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(q), status: "resolved" }] });
    const result = await extend(root, head);
    assert.deepEqual({ ...result }, { ok: true, action: "chain_extended", chainEnd: C, candidateHead: head, files: ["docs/d.md"] });
    assert.ok(await proof(root, head));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 review: the reviewer-only refusal at the cap-round head uses the shared chain coverage. Accepted form: A..B [p], B..C [q], reviewer-only baseline A names the chain-end recovery. Rejected form: no record of q names the cover run.
test("issue 3443: the reviewer-only refusal at the cap-round head names the chain-end recovery only when the union covers", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    const resolved = (f) => [{ ref: fingerprintFinding(f), status: "resolved" }];
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 1, outcome: "locally_clear", nextStep: "push", items: resolved(p) });
    const head = await commit(root, { "docs/c.md": "c\n" }, "docs C");
    const uncovered = await reviewerOnlyDelta(root, A, head).then(() => null, (error) => error);
    assert.match(uncovered?.recovery ?? "", /loop pre-push-delta --reviewer-only --cover-uncovered .*--baseline \w{40} /u, "no record of q: the cover run");
    assert.doesNotMatch(uncovered.recovery, /gate extend-cap-round-chain/u);
    assert.match(uncovered.message, /never overwritten/u);
    const C = String(runGitFixture(root, ["rev-parse", "HEAD"])).trim();
    writeSealedGateDeltaRecord(tmp, B, { reviewBaselineHead: B, candidateHead: C, actSetId: "round-4", invocation: 1, outcome: "locally_clear", nextStep: "push", items: resolved(q) });
    const head2 = await commit(root, { "docs/d.md": "d\n" }, "docs D");
    const covered = await reviewerOnlyDelta(root, A, head2).then(() => null, (error) => error);
    assert.match(covered?.recovery ?? "", /gate extend-cap-round-chain --repo \S+ --pr \S+ --worktree \S+$/u, "A..B [p], B..C [q]: the union covers, so the chain-end recovery");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 review: only merge-base exit 1 without a signal is a proven non-ancestor. Exit 128, a signal and a spawn error leave the history unresolved: the tool names the fetch, never the replacement PR.
test("issue 3443: a git failure on the later link is an unresolved history with the fetch recovery, and only exit 1 is off history", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    const C = await commit(root, { "docs/c.md": "c\n" }, "docs C");
    const head = await commit(root, { "docs/d.md": "d\n" }, "docs D");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] });
    writeSealedGateDeltaRecord(tmp, B, { reviewBaselineHead: B, candidateHead: C, actSetId: "round-4", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(q), status: "resolved" }] });
    const failing = (failure) => (cwd, args) => {
      if (args[0] === "merge-base" && args[2] === C) throw Object.assign(new Error("merge-base failed"), failure);
      return String(runGitFixture(cwd, args)).trim();
    };
    for (const failure of [{ status: 128 }, { status: null, signal: "SIGKILL" }, { code: "ENOENT" }, { status: 1, signal: "SIGTERM" }]) {
      const refused = await extend(root, head, { git: failing(failure) });
      assert.equal(refused.reason, "history_unresolved", JSON.stringify({ failure, refused }));
      assert.equal(refused.recovery, fetchIn(root, C));
      assert.match(refused.detail, /If a commit is still absent after the fetch, restart on a replacement PR/u);
      assert.doesNotMatch(refused.recovery, /replacement|operator/iu, "the recovery stays the fetch");
    }
    // Exit 1 without a signal proves C off history: the link does not count and the ref is uncovered. A ready PR (anyHead proof) is given the cover run;
    // a draft PR is not: the chain ends at C, off the history, so a cover run would leave it short of the head (issue 3443 delta review).
    const ready = await extend(root, head, { git: failing({ status: 1 }), resolveProof: async () => null, fetchPr: async () => ({ headRefOid: head, baseRefName: "main", isDraft: false }) });
    assert.equal(ready.reason, "no_cap_round_chain", JSON.stringify(ready));
    assert.match(ready.recovery, /--cover-uncovered/u);
    assert.ok(ready.detail.includes(`Uncovered act refs: ${fingerprintFinding(q)}.`), ready.detail);
    for (const fetchPr of [async () => ({ headRefOid: head, baseRefName: "main", isDraft: true }), async () => ({ headRefOid: head, baseRefName: "main" })]) {
      const draft = await extend(root, head, { git: failing({ status: 1 }), fetchPr });
      assert.equal(draft.reason, "no_cap_round_chain", JSON.stringify(draft));
      assert.equal(draft.recovery, renderCliText(replacementPrOperatorRecovery(PR)));
      assert.match(draft.detail, /This PR is a draft and no sealed clearing chain visits the PR head or ends on its history/u);
      assert.ok(draft.detail.includes(`Uncovered act refs: ${fingerprintFinding(q)}.`), draft.detail);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 3437 ac:3: the reviewer-only CLI prints the recovery of its refusal on stderr, rendered with the repo and PR", async () => {
  const { root, A, head } = await ciFailedCapFixture();
  const bin = await mkdtemp(path.join(os.tmpdir(), "fake-gh-"));
  try {
    const logPath = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`, `draft_gate-${A}.json`);
    writeFileSync(logPath, JSON.stringify({ ...JSON.parse(readFileSync(logPath, "utf8")), provenance: { perAngle: [{ angle: "correctness" }] } }));
    // The spawned CLI fetches origin/main itself: the checkout is its own origin, with main at the cap-round head.
    runGitFixture(root, ["branch", "-f", "main", A]);
    runGitFixture(root, ["remote", "add", "origin", root]);
    // The base branch read goes through `gh pr view`: a stub answers it, so the spawned CLI reaches the refusal.
    writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho '{\"headRefOid\":\"x\",\"baseRefName\":\"main\"}'\n", { mode: 0o755 });
    const out = spawnSyncTrusted(process.execPath, [path.resolve("scripts/loop/check-pre-push-delta.mjs"), "--reviewer-only", "--repo", REPO, "--pr", String(PR), "--baseline", A, "--pr-head", head, "--findings-log", logPath, "--worktree", root, "--spec-identity", "spec@1", "--result-path", path.join(root, "r.json")], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const payload = JSON.parse(out.stderr.trim().split("\n").at(-1));
    assert.equal(payload.ok, false, out.stderr);
    assert.match(payload.recovery ?? "", new RegExp(`gate extend-cap-round-chain --repo ${REPO} --pr ${PR} --worktree \\S+$`, "u"), out.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});

// The PR 3433 ledger state: three closed draft_gate rounds (the fourth, the cap round, has not closed), so no cap round resolves at the head past the sealed clear.
test("issue 3437: the PR 3433 state with fewer closed rounds than the cap routes to the next draft_gate round: the refusal names gate-coordination", async () => {
  const { root, head } = await ciFailedCapFixture({ closedRounds: 3 });
  try {
    assert.equal(await proof(root, head), null);
    const before = await coordinationAt(root, { repo: REPO, pr: PR, head });
    const { trace, end } = await followRemedy(root, { repo: REPO, pr: PR, head });
    assert.match(trace.join("\n"), /recovery: .*loop gate-coordination --repo owner\/repo --pr 70$/mu, trace.join("\n"));
    assert.equal(before.nextAction, end.nextAction);
    assert.equal(end.nextAction, "run_draft_gate", `${end.reason}\n${trace.join("\n")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 3437 ac:2: the state a ci_failed full-phase fixer leaves continues to the next gate through the recovery the refusals name, with no operator step", async () => {
  const { root, A, B, head } = await ciFailedCapFixture();
  try {
    const ledgerPath = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`, `draft_gate-${A}.json`);
    const before = await coordinationAt(root, { repo: REPO, pr: PR, head });
    assert.equal(before.nextAction, "report_blocked");
    const { trace, end } = await followRemedy(root, { repo: REPO, pr: PR, head, baseline: B, ledgerPath });
    assert.ok(["mark_ready_for_review", "run_pre_approval_gate"].includes(end.nextAction), `${end.failure}: ${end.reason}\n${trace.join("\n")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 review: the cover run is named only when it can run. The sealed cap record's candidate must be on the head's history, and no uncovered ref may have a cover record that takes no further run.
test("issue 3443 review: a sealed cap record off the head's history, or a dead-end cover record, names the replacement PR and never the cover run", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    const record = (candidateHead) => { rmSync(gateDeltaRecordPath(tmp, A), { force: true }); rmSync(`${gateDeltaRecordPath(tmp, A)}.seal`, { force: true }); writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead, actSetId: "round-3", invocation: 3, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] }); };
    const head = await commit(root, { "docs/z.md": "z\n" }, "docs");
    const sibling = String(runGitFixture(root, ["commit-tree", `${B}^{tree}`, "-p", B, "-m", "abandoned sibling"])).trim();
    const replacement = renderCliText(replacementPrOperatorRecovery(PR));
    // The record at the cap-round head names an abandoned sibling: the cover run could seal, and the next refusal would still be the replacement PR.
    record(sibling);
    const offHistory = await extend(root, head);
    assert.equal(offHistory.reason, "no_cap_round_chain", JSON.stringify(offHistory));
    assert.equal(offHistory.recovery, replacement);
    assert.doesNotMatch(offHistory.detail, /Run the cover run/u);
    // On the head's history the cover run is named.
    record(B);
    const coverable = await extend(root, head);
    assert.match(coverable.recovery, /--cover-uncovered/u);
    const cover = (over = {}) => writeCoverRecord(tmp, { capHead: A, ref: fingerprintFinding(q), candidateHead: sibling, actSetId: "set", invocation: 1, outcome: "locally_clear", nextStep: "push", status: "resolved", ...over });
    const coverPath = gateCoverRecordPath(tmp, A, fingerprintFinding(q));
    const dropCover = () => { rmSync(coverPath, { force: true }); rmSync(`${coverPath}.seal`, { force: true }); };
    // A sealed locally_clear cover record whose candidate left the history is ignored by coverage and never replaced: the replacement PR, without touching the record.
    cover();
    const sealed = [readFileSync(coverPath, "utf8"), readFileSync(`${coverPath}.seal`, "utf8")];
    const dead = await extend(root, head);
    assert.equal(dead.recovery, replacement);
    assert.match(dead.detail, /sealed locally_clear but its candidate is not on the PR head's history/u);
    assert.deepEqual([readFileSync(coverPath, "utf8"), readFileSync(`${coverPath}.seal`, "utf8")], sealed, "extend never overwrites the cover record");
    // An unsealed or unreadable one is no evidence and no count.
    rmSync(`${coverPath}.seal`);
    assert.equal((await extend(root, head)).recovery, replacement);
    writeFileSync(coverPath, "{ not json");
    assert.equal((await extend(root, head)).recovery, replacement);
    // A record that used the last invocation never restarts the bound.
    dropCover();
    cover({ outcome: "bounded_out", nextStep: "restart_on_replacement_pr", status: "not_resolved", invocation: 3 });
    assert.equal((await extend(root, head)).recovery, replacement);
    // A needs_fix record below the bound takes another run: the cover run is named again.
    dropCover();
    cover({ outcome: "needs_fix", nextStep: "fix_and_rereview", status: "not_resolved", invocation: 1 });
    assert.match((await extend(root, head)).recovery, /--cover-uncovered/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 review: the failure names the commit this clone lacks. An unfetched PR head is named for the fetch, not the present candidate whose fetch would change nothing.
test("issue 3443 review: history_unresolved names the unfetched PR head and the next exit for a commit that stays absent", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    const C = await commit(root, { "docs/c.md": "c\n" }, "docs C");
    const head = await commit(root, { "docs/d.md": "d\n" }, "docs D");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] });
    writeSealedGateDeltaRecord(tmp, B, { reviewBaselineHead: B, candidateHead: C, actSetId: "round-4", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(q), status: "resolved" }] });
    const headMissing = (cwd, args) => {
      if (args[0] === "merge-base" && args[3] === head) throw Object.assign(new Error("fatal: Not a valid commit name"), { status: 128 });
      if (args[0] === "cat-file" && args[2] === `${head}^{commit}`) throw Object.assign(new Error("missing"), { status: 1 });
      return String(runGitFixture(cwd, args)).trim();
    };
    const refused = await extend(root, head, { git: headMissing });
    assert.equal(refused.reason, "history_unresolved", JSON.stringify(refused));
    assert.equal(refused.recovery, fetchIn(root, head), "the missing PR head, not the present candidate");
    assert.doesNotMatch(refused.detail, new RegExp(`fetch origin ${C}`, "u"));
    assert.match(refused.detail, /If a commit is still absent after the fetch, restart on a replacement PR/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 delta review: the extension tool's history bound matches the proof's. A candidate that is not a full hex SHA never reaches git (it is off the history), so a malformed sealed record yields a typed refusal and no crash.
test("issue 3443: a malformed candidate on a sealed later link is off the history, not a git argument", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  for (const malformed of ["abc123", ""]) {
    const { root, A, B } = await capFixture({ findings: [p, q] });
    try {
      const tmp = path.join(root, "tmp");
      writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] });
      writeSealedGateDeltaRecord(tmp, B, { reviewBaselineHead: B, candidateHead: malformed, actSetId: "round-4", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(q), status: "resolved" }] });
      const head = await commit(root, { "docs/c.md": "c\n" }, "docs C");
      const refused = await extend(root, head, { fetchPr: async () => ({ headRefOid: head, baseRefName: "main", isDraft: false }) });
      assert.equal(refused.reason, "no_cap_round_chain", `${JSON.stringify(malformed)}: ${JSON.stringify(refused)}`);
      assert.ok(refused.detail.includes(`Uncovered act refs: ${fingerprintFinding(q)}.`), "the malformed link covers nothing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

// Issue 3443 delta review (RECOVERY-COMMAND-REQUIRED): the cover recovery carries the resolved worktree, and a draft PR whose chain end is on the history keeps the cover run.
test("issue 3443: the cover recovery carries the resolved worktree and a draft PR with a chain end on the history keeps the cover run", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] });
    const refused = await extend(root, B, { fetchPr: async () => ({ headRefOid: B, baseRefName: "main", isDraft: true }) });
    assert.equal(refused.reason, "no_cap_round_chain");
    assert.ok(refused.recovery.includes("--cover-uncovered"), refused.recovery);
    assert.ok(refused.recovery.endsWith(`--worktree ${shellQuote(path.resolve(root))}`), refused.recovery);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 delta review: the tool reads the cover records under the sequence lock of the cap-round head, so a cover run that is replacing a record (the seal removed, the new one not yet linked) is never read as an unsealed dead end.
test("issue 3443: the cover blocker is read under the cap-round head's sequence lock and waits for a write in progress", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] });
    const cover = { capHead: A, ref: fingerprintFinding(q), candidateHead: B, actSetId: "set", invocation: 1, outcome: "needs_fix", nextStep: "fix_and_rereview", status: "not_resolved" };
    writeCoverRecord(tmp, cover);
    let result;
    await withSequenceLock(tmp, [A], async () => {
      rmSync(`${gateCoverRecordPath(tmp, A, cover.ref)}.seal`); // a write in progress
      let settled = false;
      const attempt = lockAttempt();
      const pending = extend(root, B, { withLock: attempt.withLock }).then((value) => { settled = true; return value; });
      await attempt.reached; // the tool finished its pre-lock reads and is waiting on the held lock (no sleep)
      assert.equal(settled, false, "the read waits for the held lock");
      rmSync(gateCoverRecordPath(tmp, A, cover.ref)); // the write completes: the new record and its seal appear together
      writeCoverRecord(tmp, { ...cover, actSetId: "set-2" });
      result = pending;
    });
    const refused = await result;
    assert.equal(refused.reason, "no_cap_round_chain");
    assert.ok(refused.recovery.includes("--cover-uncovered"), "the completed write is a retryable record, so the cover run is named, not the replacement PR");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 delta review: a chain that visits the PR head reaches it, however far a sealed record continues past it (A..H [p], H..X after a reset of X to H).
test("issue 3443: a draft PR whose chain visits the head and continues past it keeps the cover run", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    const X = "e".repeat(40);
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] });
    writeSealedGateDeltaRecord(tmp, B, { reviewBaselineHead: B, candidateHead: X, actSetId: "round-4", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(q), status: "resolved" }] });
    const refused = await extend(root, B, { fetchPr: async () => ({ headRefOid: B, baseRefName: "main", isDraft: true }) });
    assert.equal(refused.reason, "no_cap_round_chain", JSON.stringify(refused));
    assert.ok(refused.recovery.includes("--cover-uncovered"), refused.recovery);
    assert.ok(refused.detail.includes(`Uncovered act refs: ${fingerprintFinding(q)}.`), "the link past the head covers nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 delta review: the coverage read before the lock is stale once a cover run completes during the wait: the tool rereads it under the lock and names the rerun, never a candidate off the history.
test("issue 3443: a cover run that completes as locally_clear during the lock wait returns the rerun, not the replacement PR", async () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  const [p, q] = [act("guard missing"), act("second defect")];
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, { reviewBaselineHead: A, candidateHead: B, actSetId: "round-3", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: fingerprintFinding(p), status: "resolved" }] });
    const cover = { capHead: A, ref: fingerprintFinding(q), candidateHead: B, actSetId: "set", invocation: 1, outcome: "needs_fix", nextStep: "fix_and_rereview", status: "not_resolved" };
    writeCoverRecord(tmp, cover);
    let result;
    await withSequenceLock(tmp, [A], async () => {
      const attempt = lockAttempt();
      const pending = extend(root, B, { withLock: attempt.withLock });
      await attempt.reached; // the pre-lock coverage read is done and the tool waits for the held lock (no sleep)
      rmSync(gateCoverRecordPath(tmp, A, cover.ref));
      rmSync(`${gateCoverRecordPath(tmp, A, cover.ref)}.seal`, { force: true });
      writeCoverRecord(tmp, { ...cover, outcome: "locally_clear", nextStep: "push_to_gate", status: "resolved", invocation: 2 });
      result = pending;
    });
    const refused = await result;
    assert.equal(refused.reason, "record_changed", JSON.stringify(refused));
    assert.match(refused.recovery, /gate extend-cap-round-chain --repo \S+ --pr \S+ --worktree \S+$/u);
    assert.doesNotMatch(refused.detail, /not on the PR head's history|replacement PR: /u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 delta review: every rerun recovery carries the resolved worktree, so it runs from any caller directory.
test("issue 3443: the rerun recoveries name the resolved worktree", async () => {
  const { root, B } = await capFixture({});
  try {
    const refused = await extendCapRoundChain({ repo: REPO, pr: PR, worktree: root }, { detectOriginSlug: () => "other/repo", fetchPr: async () => ({ headRefOid: B, baseRefName: "main" }), fetchBaseBranch: () => {} });
    assert.equal(refused.reason, "repo_mismatch");
    assert.ok(refused.recovery.endsWith(`--worktree ${shellQuote(path.resolve(root))}`), refused.recovery);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Issue 3443 round 4 helpers: two act findings, a sibling commit (off the head's history) and a sealed clearing record.
const roundFour = () => {
  const act = (summary) => ({ severity: "medium", summary, files: ["src/a.mjs"], line: 1, angle: "correctness", judgeDisposition: "act", judgeTitle: summary, judgeFix: "add" });
  return [act("guard missing"), act("second defect")];
};
const sibling = (root, parent, message) => String(runGitFixture(root, ["commit-tree", "-p", parent, "-m", message, `${parent}^{tree}`])).trim();
const clearing = (baseline, candidate, items = []) => ({ reviewBaselineHead: baseline, candidateHead: candidate, actSetId: `set-${candidate.slice(0, 4)}`, invocation: 1, outcome: "locally_clear", nextStep: "push", items });
const coverFor = (capHead, ref, candidateHead) => ({ capHead, ref, candidateHead, actSetId: "set", invocation: 1, outcome: "locally_clear", nextStep: "push_to_gate", status: "resolved" });
const resolved = (...findings) => findings.map((f) => ({ ref: fingerprintFinding(f), status: "resolved" }));

// Round 4 (false replacement-PR path): coordination proves a ready PR with anyHead, so the tool returns already_proven for a state that proof accepts, and a draft PR still refuses.
test("issue 3443 round 4: a ready PR that the anyHead proof accepts is already_proven, and the same state on a draft PR refuses", async () => {
  const [p, q] = roundFour();
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    const C = sibling(root, B, "abandoned link candidate");
    const H = await commit(root, { "docs/h.md": "h\n" }, "ready head");
    writeSealedGateDeltaRecord(tmp, A, clearing(A, B, resolved(p)));
    writeSealedGateDeltaRecord(tmp, B, clearing(B, C));
    writeCoverRecord(tmp, coverFor(A, fingerprintFinding(q), H));
    const ready = await extend(root, H, { fetchPr: async () => ({ headRefOid: H, baseRefName: "main", isDraft: false }) });
    assert.equal(ready.action, "already_proven", JSON.stringify(ready));
    assert.equal(await proof(root, H), null, "the draft proof does not accept this chain: the abandoned link ends it off the head");
    for (const isDraft of [true, undefined]) {
      const draft = await extend(root, H, { fetchPr: async () => ({ headRefOid: H, baseRefName: "main", ...(isDraft === undefined ? {} : { isDraft }) }) });
      assert.equal(draft.action, undefined, "an unreadable draft state reads as a draft");
      assert.equal(draft.reason, "no_cap_round_chain", JSON.stringify(draft));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Round 4 (unknown history fails closed): a clean cap round whose sealed record at the cap-round head names a candidate this clone lacks asks for the fetch, never record_exists (which routes back to coordination).
test("issue 3443 round 4: a clean cap round with an unreadable sealed candidate returns the fetch, and a proven off-history one keeps the fallback", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const tmp = path.join(root, "tmp");
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs d");
    const absent = "9".repeat(40);
    writeSealedGateDeltaRecord(tmp, A, clearing(A, absent));
    const refused = await extend(root, D);
    assert.equal(refused.reason, "history_unresolved", JSON.stringify(refused));
    assert.equal(refused.recovery, fetchIn(root, absent));
    // Control: git proves the candidate off the history (exit 1): the cap-head fallback is kept, so the clearing record at the cap-round head is record_exists.
    const off = sibling(root, A, "abandoned sibling");
    const recordPath = gateDeltaRecordPath(tmp, A);
    rmSync(recordPath); rmSync(`${recordPath}.seal`);
    writeSealedGateDeltaRecord(tmp, A, clearing(A, off));
    assert.equal((await extend(root, D)).reason, "record_exists");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Round 4: the one candidate rule. A ready PR whose first candidate git proves off the history keeps the cover run (its anyHead proof accepts the first record whatever its candidate); a draft PR gets the replacement PR; an unreadable history the fetch.
test("issue 3443 round 4: a ready PR with an off-history first candidate gets the cover run, a draft PR the replacement PR and an unreadable history the fetch", async () => {
  const [p, q] = roundFour();
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    const X = sibling(root, A, "amended-away candidate");
    const H = await commit(root, { "docs/h.md": "h\n" }, "head after B");
    writeSealedGateDeltaRecord(tmp, A, clearing(A, X, resolved(p)));
    const ready = await extend(root, H, { fetchPr: async () => ({ headRefOid: H, baseRefName: "main", isDraft: false }) });
    assert.equal(ready.reason, "no_cap_round_chain", JSON.stringify(ready));
    assert.match(ready.recovery, /--cover-uncovered/u);
    const draft = await extend(root, H, { fetchPr: async () => ({ headRefOid: H, baseRefName: "main", isDraft: true }) });
    assert.equal(draft.reason, "no_cap_round_chain", JSON.stringify(draft));
    assert.equal(draft.recovery, renderCliText(replacementPrOperatorRecovery(PR)));
    const unreadable = (cwd, args) => { if (args[0] === "merge-base" && args[2] === X) throw Object.assign(new Error("merge-base failed"), { status: 128 }); return String(runGitFixture(cwd, args)).trim(); };
    const unresolved = await extend(root, H, { git: unreadable, fetchPr: async () => ({ headRefOid: H, baseRefName: "main", isDraft: false }) });
    assert.equal(unresolved.reason, "history_unresolved", JSON.stringify(unresolved));
    assert.equal(unresolved.recovery, fetchIn(root, X));
    assert.ok(B, "fixture B exists");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Round 4 (false replacement PR): a cover run that completes between the covering read that computed the chain ends and the second coverage read leaves nothing uncovered while the ends are stale: the tool returns record_changed.
// The deterministic point is the git call that follows the first read (the cap-round head ancestry probe), so no sleep decides the order.
test("issue 3443 round 4: a cover run that lands between the two pre-lock reads returns record_changed, and a stable covered state keeps the replacement PR", async () => {
  const [p, q] = roundFour();
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    const H = await commit(root, { "docs/h.md": "h\n" }, "head after B");
    writeSealedGateDeltaRecord(tmp, A, clearing(A, B, resolved(p)));
    let fired = false;
    const racing = (cwd, args) => {
      if (!fired && args[0] === "merge-base" && args[2] === A) { fired = true; writeCoverRecord(tmp, coverFor(A, fingerprintFinding(q), H)); }
      return String(runGitFixture(cwd, args)).trim();
    };
    const refused = await extend(root, H, { git: racing });
    assert.equal(fired, true, "the cover record landed between the two reads");
    assert.equal(refused.reason, "record_changed", JSON.stringify(refused));
    assert.match(refused.recovery, /gate extend-cap-round-chain --repo \S+ --pr \S+ --worktree \S+$/u);
    // Control: a first record that names every ref covers at the first read, so an off-history candidate is the replacement PR and never record_changed.
    const X = sibling(root, A, "abandoned");
    rmSync(gateDeltaRecordPath(tmp, A)); rmSync(`${gateDeltaRecordPath(tmp, A)}.seal`);
    rmSync(gateCoverRecordPath(tmp, A, fingerprintFinding(q))); rmSync(`${gateCoverRecordPath(tmp, A, fingerprintFinding(q))}.seal`, { force: true });
    writeSealedGateDeltaRecord(tmp, A, clearing(A, X, resolved(p, q)));
    const stable = await extend(root, H);
    assert.equal(stable.reason, "no_cap_round_chain", JSON.stringify(stable));
    assert.equal(stable.recovery, renderCliText(replacementPrOperatorRecovery(PR)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Round 4 (scan before the lock): the chain starts, bridges and base-only probes are scanned before the sequence lock; under it only the linked and cover records are read again, and a clear that lands during the wait is still seen.
test("issue 3443 round 4: the extension tool probes no base-only merge while it holds the lock, and a clear that lands during the wait is still seen", async () => {
  const [p, q] = roundFour();
  const { root, A, B } = await capFixture({ findings: [p, q] });
  try {
    const tmp = path.join(root, "tmp");
    writeSealedGateDeltaRecord(tmp, A, clearing(A, B, resolved(p)));
    // A sealed clearing record at another baseline makes the scan probe it as a base-only merge of the cap-round head.
    writeSealedGateDeltaRecord(tmp, "7".repeat(40), clearing("7".repeat(40), B));
    writeCoverRecord(tmp, { ...coverFor(A, fingerprintFinding(q), B), outcome: "needs_fix", nextStep: "fix_and_rereview", status: "not_resolved" });
    let held = false;
    const probes = [];
    const attempt = lockAttempt();
    const withLock = (root_, heads, fn) => attempt.withLock(root_, heads, async () => { held = true; try { return await fn(); } finally { held = false; } });
    const baseOnlyMerge = async () => { probes.push(held); return false; };
    let result;
    await withSequenceLock(tmp, [A], async () => {
      const pending = extend(root, B, { withLock, baseOnlyMerge });
      await attempt.reached;
      // The concurrent cover run completes while the tool waits for the lock.
      rmSync(gateCoverRecordPath(tmp, A, fingerprintFinding(q))); rmSync(`${gateCoverRecordPath(tmp, A, fingerprintFinding(q))}.seal`, { force: true });
      writeCoverRecord(tmp, coverFor(A, fingerprintFinding(q), B));
      result = pending;
    });
    const refused = await result;
    assert.equal(refused.reason, "record_changed", JSON.stringify(refused));
    assert.ok(probes.length > 0 && probes.every((inLock) => inLock === false), `no base-only probe ran under the lock: ${probes}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
