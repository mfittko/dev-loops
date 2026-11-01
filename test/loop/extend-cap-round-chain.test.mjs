import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";

import { resolveCapRoundFixed } from "../../scripts/github/write-gate-context.mjs";
import { readSealedGateDeltaRecord, writeSealedGateDeltaRecord } from "../../scripts/loop/_gate-delta-record.mjs";
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

const extend = (root, head, deps = {}) => extendCapRoundChain({ repo: REPO, pr: PR, worktree: root }, { fetchPr: async () => ({ headRefOid: head, baseRefName: "main" }), fetchBaseBranch: () => {}, ...deps });
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
    assert.match(refused.detail, /gate-coordination/);
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
    assert.equal((await extend(root, A)).reason, "no_cap_round_chain");
    const D = await commit(root, { "docs/d.md": "d\n" }, "docs");
    const gone = "a".repeat(40);
    const dir = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`);
    await writeFile(path.join(dir, `draft_gate-${gone}.json`), JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", headSha: gone, verdict: "findings_present", loggedAt: "2026-11-09T00:00:00.000Z", findings: [] }), "utf8");
    assert.equal((await extend(root, D)).reason, "no_cap_round_chain");
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
    const code = await runCli(["--repo", REPO, "--pr", String(PR), "--worktree", root], { stdout, stderr, fetchPr: async () => { throw new Error("gh down"); } });
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stderr.chunks.join("")), { ok: false, refused: true, reason: "writer_error", detail: "gh down" });
    const refusedErr = sink();
    assert.equal(await runCli(["--repo", REPO, "--pr", String(PR), "--worktree", root], { stdout, stderr: refusedErr, fetchPr: async () => ({}) }), 1);
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
