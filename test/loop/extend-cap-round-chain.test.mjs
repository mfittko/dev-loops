import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";

import { resolveCapRoundFixed } from "../../scripts/github/write-gate-context.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { gateDeltaRecordPath, readGateDeltaRecord, readSealedGateDeltaRecord, writeSealedGateDeltaRecord } from "../../scripts/loop/_gate-delta-record.mjs";
import { extendCapRoundChain, parseExtendCapRoundChainCliArgs, runCli } from "../../scripts/loop/extend-cap-round-chain.mjs";
import { initGitFixture, runGitFixture } from "../_helpers.mjs";

const REPO = "owner/repo";
const PR = 70;

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
    assert.match(refused.detail, /src\/b\.mjs/);
    assert.match(refused.detail, /pre-push-delta --baseline /u);
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
    assert.equal((await extend(root, "9".repeat(40))).reason, "head_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const bare = await mkdtemp(path.join(os.tmpdir(), "extend-cap-chain-"));
  try {
    initGitFixture(bare, { commit: null });
    const head = await commit(bare, { "docs/z.md": "z\n" }, "docs");
    const refused = await extend(bare, head);
    assert.equal(refused.reason, "no_cap_round_chain");
    assert.match(refused.detail, /check-pre-push-delta\.mjs --result/);
    assert.match(refused.detail, /gate-coordination .* routes this refusal back to this command, so only the pre-push delta or the replacement-PR restart breaks the cycle/);
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the cap-round head equal to the head, or an unfetched cap-round head, refuses no_cap_round_chain, never baseline_orphaned", async () => {
  const { root, A } = await capFixture();
  try {
    runGitFixture(root, ["checkout", "-q", A]);
    const equal = await extend(root, A);
    assert.equal(equal.reason, "no_cap_round_chain");
    assert.match(equal.detail, /check-pre-push-delta\.mjs --result/);
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const gone = "a".repeat(40);
    const dir = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`);
    await writeFile(path.join(dir, `draft_gate-${gone}.json`), JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", headSha: gone, verdict: "findings_present", loggedAt: "2026-11-09T00:00:00.000Z", findings: [] }), "utf8");
    const unfetched = await extend(root, D, { fetchPr: async () => ({ headRefOid: D, baseRefName: "trunk" }) });
    assert.equal(unfetched.reason, "no_cap_round_chain");
    assert.match(unfetched.detail, /`git rev-parse --is-shallow-repository`.*`git fetch --unshallow`.*`git fetch origin a{40}`/);
    assert.match(unfetched.detail, /rerun `[^`]*gate extend-cap-round-chain --repo owner\/repo --pr \d+`/);
    assert.match(unfetched.detail, /still absent.*replacement PR/);
    assert.doesNotMatch(unfetched.detail, /git fetch origin (trunk|main)/);
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
    assert.deepEqual(JSON.parse(stderr.chunks.join("")), { ok: false, refused: true, reason: "writer_error", detail: "gh down" });
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
    assert.match(refused.detail, /git fetch origin main/);
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
    assert.doesNotMatch(refused.detail, /extend-cap-round-chain|gate-coordination/);
    assert.match(refused.detail, /check-pre-push-delta\.mjs --result/);
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
    assert.match(refused.detail, /no act list/u);
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
    // At the cap-round head the round is the head being posted (no cap round yet): the clean draft_gate verdict path applies, and nothing is written.
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

test("a clean cap round whose plain clearing chain ends at the PR head refuses chain_reaches_head and writes nothing", async () => {
  const { root, A } = await cleanCapFixture();
  try {
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    writeSealedGateDeltaRecord(path.join(root, "tmp"), A, { reviewBaselineHead: A, candidateHead: D, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
    const result = await extend(root, D);
    assert.equal(result.reason, "chain_reaches_head");
    assert.match(result.detail, /further docs or tests commit/u);
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
    assert.match(result.detail, /only the thread-route pre-push delta .*--threads-file.*at least one unresolved review thread.*replacement PR.*does not break the cycle/u);
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
    assert.ok(refused.detail.includes(`for ${E.slice(0, 7)}..`), refused.detail);
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
