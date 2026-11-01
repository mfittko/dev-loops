import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { resolveCapRoundFixed } from "../../scripts/github/write-gate-context.mjs";
import { readSealedGateDeltaRecord, writeSealedGateDeltaRecord } from "../../scripts/loop/_gate-delta-record.mjs";
import { extendCapRoundChain } from "../../scripts/loop/extend-cap-round-chain.mjs";
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
async function capFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "extend-cap-chain-"));
  initGitFixture(root, { commit: null });
  const A = await commit(root, { ".gitignore": "tmp/\n", "src/a.mjs": "export const a = 1;\n" }, "base");
  const B = await commit(root, { "src/a.mjs": "export const a = 2;\n" }, "fixer");
  const dir = path.join(root, "tmp", "gate-findings", "owner-repo", `pr-${PR}`);
  await mkdir(dir, { recursive: true });
  for (const [i, head] of ["1".repeat(40), "2".repeat(40), "3".repeat(40), A].entries()) {
    await writeFile(path.join(dir, `draft_gate-${head}.json`), JSON.stringify({
      repo: REPO, pr: PR, gate: "draft_gate", headSha: head, verdict: "findings_present", loggedAt: `2026-11-0${i + 1}T00:00:00.000Z`, findings: [],
    }), "utf8");
  }
  writeSealedGateDeltaRecord(path.join(root, "tmp"), A, { reviewBaselineHead: A, candidateHead: B, outcome: "locally_clear", nextStep: "push_to_gate", items: [] });
  return { root, A, B };
}

const extend = (root, head) => extendCapRoundChain({ repo: REPO, pr: PR, worktree: root }, { fetchPr: async () => ({ headRefOid: head, baseRefName: "main" }) });
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
    assert.equal((await extend(root, D)).action, "already_proven");
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
