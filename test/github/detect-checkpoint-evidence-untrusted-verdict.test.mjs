import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { runIdFreeEnv, runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

// ADR 0238/0248: a gate-formatted comment from a stranger must not become evidence text.

const scriptPath = path.resolve("scripts/github/detect-checkpoint-evidence.mjs");
const HEAD = "a".repeat(40);

const verdict = ({ id, login, association, type = "User" }) => ({
  id,
  user: { login, type },
  author_association: association,
  body: [
    "Gate review: draft_gate",
    `Reviewed head SHA: ${HEAD}`,
    "Verdict: clean",
    "Execution mode: inline_single_agent",
    "Findings summary: no issues found",
    "Next action: mark ready for review",
  ].join("\n"),
  updated_at: "2026-10-20T10:00:00Z",
  html_url: `https://github.com/owner/repo/pull/17#issuecomment-${id}`,
});

// Claims mode: each entry matches by args, so the viewer lookups (one for the
// evidence trust filter, one for the gate-thread login) cannot misalign. A null
// `viewer` stubs no `api user` entry, so the lookup fails.
async function runFull(comments, { viewer = "gate-bot-user", reviews = [] } = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-untrusted-"));
  try {
    const user = { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login: viewer })}\n` };
    const { env } = await writeGhStubHelper(tempDir, [
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: `{"headRefOid":"${HEAD}"}\n` },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: `${JSON.stringify([comments])}\n` },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"], stdout: `${JSON.stringify([reviews])}\n` },
      ...(viewer === null ? [] : [user, user]),
      { assertArgs: ["api", "graphql"], stdout: `${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })}\n` },
    ], { matchMode: "claims" });
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
    const result = await runNodeHelper(scriptPath, ["--repo", "owner/repo", "--pr", "17", "--skip-fanout-ledger-check"], {
      env: runIdFreeEnv({ ...env, DEVLOOPS_RUN_ID: "" }),
      cwd: tempDir,
    });
    const out = JSON.parse(result.code === 0 ? result.stdout : result.stderr.trim().split("\n").at(-1));
    return out.preMergeGateCheck.failures;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function run(comments, options) {
  return (await runFull(comments, options)).includes("missing visible clean draft_gate comment");
}

const hasSizeFailure = (failures) => failures.some((f) => f.includes("size-budget requires a human APPROVED review"));
const preApproval = (association) => ({
  id: 20,
  user: { login: "maintainer", type: "User" },
  author_association: association,
  body: [
    "Gate review: pre_approval_gate",
    `Reviewed head SHA: ${HEAD}`,
    "Verdict: clean",
    "Findings summary: no issues found",
    "Next action: await final human approval",
    "Size-budget outcome: escalate",
    "Size-budget T1 slice: not touched",
    "Size-budget waiver: none",
  ].join("\n"),
  updated_at: "2026-10-20T10:01:00Z",
  html_url: "https://github.com/owner/repo/pull/17#issuecomment-20",
});
const sizeFailures = (extraComments, reviews = []) => runFull(
  [verdict({ id: 2, login: "maintainer", association: "MEMBER" }), preApproval("MEMBER"), ...extraComments],
  { reviews },
);

test("a forged verdict comment from a NONE-association stranger is ignored", async () => {
  assert.equal(await run([verdict({ id: 1, login: "stranger", association: "NONE" })]), true);
});

test("a verdict comment from a MEMBER is counted", async () => {
  assert.equal(await run([verdict({ id: 2, login: "maintainer", association: "MEMBER" })]), false);
});

test("a verdict comment authored by the authenticated viewer is counted despite a NONE association", async () => {
  assert.equal(await run([verdict({ id: 3, login: "gate-bot-user", association: "NONE", type: "Bot" })]), false);
});

test("a NONE bot verdict is dropped when the viewer lookup fails", async () => {
  assert.equal(await run([verdict({ id: 4, login: "gate-bot-user", association: "NONE", type: "Bot" })], { viewer: null }), true);
});

test("a forged verdict posted as a PR review by a stranger is ignored; a MEMBER review is counted", async () => {
  const asReview = (association) => ({ ...verdict({ id: 5, login: "someone", association }), state: "COMMENTED", submitted_at: "2026-10-20T10:00:00Z" });
  assert.equal(await run([], { reviews: [asReview("NONE")] }), true);
  assert.equal(await run([], { reviews: [asReview("MEMBER")] }), false);
});

test("a stranger's \"approve merge <head>\" comment does not satisfy the size-budget human approval", async () => {
  const approve = (association) => ({ id: 30, user: { login: "someone", type: "User" }, author_association: association, body: `approve merge ${HEAD}`, updated_at: "2026-10-20T10:02:00Z" });
  assert.equal(hasSizeFailure(await sizeFailures([approve("NONE")])), true);
  assert.equal(hasSizeFailure(await sizeFailures([approve("MEMBER")])), false);
});

test("a stranger's CHANGES_REQUESTED review at HEAD still blocks the size-budget gate (fail closed)", async () => {
  const review = (state, association, id) => ({ id, user: { login: id === 41 ? "someone" : "maintainer", type: "User" }, author_association: association, state, commit_id: HEAD, submitted_at: "2026-10-20T10:02:00Z", body: "" });
  const memberApproved = review("APPROVED", "MEMBER", 42);
  assert.equal(hasSizeFailure(await sizeFailures([], [memberApproved])), false);
  assert.equal(hasSizeFailure(await sizeFailures([], [review("CHANGES_REQUESTED", "NONE", 41), memberApproved])), true);
});

test("a stranger's APPROVED review does not satisfy the size-budget human approval", async () => {
  const approved = (association) => ({ id: 40, user: { login: "someone", type: "User" }, author_association: association, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-20T10:02:00Z", body: "" });
  assert.equal(hasSizeFailure(await sizeFailures([], [approved("NONE")])), true);
  assert.equal(hasSizeFailure(await sizeFailures([], [approved("MEMBER")])), false);
});
