import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { evidenceDigest, renderCarriedHeadsBody } from "../../scripts/github/_carried-verdict.mjs";
import { computeBaseMergeCarry } from "../../scripts/github/classify-base-merge-carry.mjs";
import { readyForReview } from "../../scripts/github/ready-for-review.mjs";
import { restoreReady } from "../../scripts/github/restore-ready.mjs";
import { renderGateReviewCommentBody, summarizeExistingComment } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { prePrReadyGate } from "../../scripts/loop/pre-pr-ready-gate.mjs";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined };
const REPO = "owner/repo";

// A PR whose clean draft_gate was posted at `origin` and carried across a base-only merge to `cur`.
async function setup({ carried }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "carried-ci-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, env: ENV, encoding: "utf8" }).trim();
  const put = (f, c) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); };
  git("init", "-q", "-b", "main");
  put("base.txt", "base\n"); git("add", "-A"); git("commit", "-qm", "base");
  git("checkout", "-qb", "pr");
  put("src/x.mjs", "x\n"); git("add", "-A"); git("commit", "-qm", "pr");
  const origin = git("rev-parse", "HEAD");
  let cur = origin;
  if (carried) {
    git("checkout", "-q", "main"); put("docs/a.md", "changed\n"); git("add", "-A"); git("commit", "-qm", "main");
    git("checkout", "-q", "pr"); git("merge", "-q", "--no-edit", "main");
    cur = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", "main");
  }
  // The coordination-recorded carried-heads comment (ADR 0186); a ready-path reader only reads it.
  const evidence = carried ? await computeBaseMergeCarry({ prevHead: origin, headSha: cur, baseRef: "origin/main", repoRoot: dir }) : null;
  const record = evidence && { id: 2, body: renderCarriedHeadsBody([{ gate: "draft_gate", originHead: origin, headSha: cur, decision: evidence.decision, evidenceDigest: evidenceDigest(evidence) }]) };
  return { dir, origin, cur, record };
}

function router({ origin, cur, record }, ciBucket) {
  const body = renderGateReviewCommentBody({ gate: "draft_gate", headSha: origin, repo: REPO, verdict: "clean", findingsSummary: "none", nextAction: "mark ready for review" });
  const calls = [];
  const runChild = async (_cmd, args) => {
    calls.push(args);
    const text = args.join(" ");
    if (args[0] === "pr" && args[1] === "checks") return { code: ciBucket === "fail" ? 1 : 0, stdout: JSON.stringify([{ bucket: ciBucket, name: "ci" }]), stderr: "" };
    if (args.includes("baseRefName") && args[1] === "view") return { code: 0, stdout: JSON.stringify({ baseRefName: "main" }), stderr: "" };
    if (text.includes("issues/7/comments")) return { code: 0, stdout: JSON.stringify([[{ id: 1, body, created_at: "2026-01-01T00:00:00Z" }, ...(record ? [{ ...record, created_at: "2026-01-01T00:00:01Z" }] : [])]]), stderr: "" };
    if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: JSON.stringify({ login: "bot" }), stderr: "" };
    if (text.includes("reviewThreads")) {
      return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }), stderr: "" };
    }
    if (args[0] === "api" && args[1] === "graphql") {
      return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { id: "PR_1", isDraft: true, headRefOid: cur, baseRefName: "main", state: "OPEN", title: "t", body: "" } } } }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unavailable" };
  };
  return { runChild, ciChecked: () => calls.some((a) => a[0] === "pr" && a[1] === "checks") };
}

for (const bucket of ["fail", "pending"]) {
  test(`carried verdict + ${bucket} CI: restore-ready and the raw pr-ready guard refuse`, async () => {
    const s = await setup({ carried: true });
    const opts = { repo: REPO, pr: 7 };
    const a = router(s, bucket);
    await assert.rejects(restoreReady(opts, { env: {}, repoRoot: s.dir, runChild: a.runChild }), /blocking CI checks|CI is not green/);
    const b = router(s, bucket);
    const result = await prePrReadyGate(opts, { env: {}, repoRoot: s.dir, runChild: b.runChild });
    assert.equal(result.ok, false);
    assert.match(result.error, /carried from an earlier head and current-head CI is not green/);
  });
}

test("non-carried clean verdict: restore-ready and the raw pr-ready guard do not consult CI", async () => {
  const s = await setup({ carried: false });
  const opts = { repo: REPO, pr: 7 };
  const a = router(s, "fail");
  await restoreReady(opts, { env: {}, repoRoot: s.dir, runChild: a.runChild }).catch(() => {});
  assert.equal(a.ciChecked(), false);
  const b = router(s, "fail");
  await prePrReadyGate(opts, { env: {}, repoRoot: s.dir, runChild: b.runChild }).catch(() => {});
  assert.equal(b.ciChecked(), false);
});

test("ordinary ready-for-review still checks CI first (unchanged)", async () => {
  const s = await setup({ carried: false });
  const a = router(s, "fail");
  await assert.rejects(readyForReview({ repo: REPO, pr: 7 }, { env: {}, repoRoot: s.dir, runChild: a.runChild }), /blocking CI checks/);
});

test("summarizeExistingComment never treats a carried marker as same-head evidence", () => {
  const head = "a".repeat(40);
  const marker = { visible: true, headSha: head, verdict: "clean", commentId: 1, carriedFrom: "b".repeat(40) };
  assert.equal(summarizeExistingComment({ strict: null, marker, headSha: head }) == null || summarizeExistingComment({ strict: null, marker, headSha: head }).kind !== "marker", true);
  assert.equal(summarizeExistingComment({ strict: null, marker: { ...marker, carriedFrom: undefined }, headSha: head }).kind, "marker");
});
