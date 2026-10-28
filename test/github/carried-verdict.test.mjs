import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { carryGateMarker } from "../../scripts/github/_carried-verdict.mjs";
import { fetchDraftGateEvidence } from "../../scripts/github/_gate-finding-surface.mjs";
import { renderGateReviewCommentBody } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined };
const REPO = "owner/repo";

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "carried-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, env: ENV, encoding: "utf8" }).trim();
  const put = (f, c) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); };
  git("init", "-q", "-b", "main");
  put("base.txt", "base\n");
  git("add", "-A"); git("commit", "-qm", "base");
  git("checkout", "-qb", "pr");
  put("src/x.mjs", "x\n");
  git("add", "-A"); git("commit", "-qm", "pr");
  const head = () => git("rev-parse", "HEAD");
  const mergeBase = (file) => {
    git("checkout", "-q", "main"); put(file, "changed\n"); git("add", "-A"); git("commit", "-qm", `main ${file}`);
    git("checkout", "-q", "pr"); git("merge", "-q", "--no-edit", "main");
    return head();
  };
  return { dir, git, put, head, mergeBase };
}
const marker = (headSha) => ({ visible: true, verdict: "clean", contractComplete: true, headSha });
const carry = (s, m, currentHeadSha) => carryGateMarker(m, { currentHeadSha, baseRef: "main", repoRoot: s.dir });

// Fresh-runner path (#2752 decision 4): setup() builds a bare checkout with no tmp/ state, so
// every case below recomputes the carry from the posted marker and git facts alone.
test("a base-only merge carries from a checkout with no tmp state", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const carried = await carry(s, marker(origin), cur);
  assert.equal(carried.headSha, cur);
  assert.equal(carried.carriedFrom, origin);
});

test("a head with a PR-own change after the clean verdict does not carry", async () => {
  const s = setup();
  const origin = s.head();
  s.put("src/x.mjs", "changed pr blob\n"); s.git("add", "-A"); s.git("commit", "-qm", "pr edit");
  const cur = s.mergeBase("docs/a.md");
  const m = marker(origin);
  assert.deepEqual(await carry(s, m, cur), m);
});


test("two consecutive base merges both carry from the same origin head", async () => {
  const s = setup();
  const origin = s.head();
  const first = s.mergeBase("docs/a.md");
  const second = s.mergeBase("docs/b.md");
  assert.equal((await carry(s, marker(origin), first)).carriedFrom, origin);
  assert.equal((await carry(s, marker(origin), second)).carriedFrom, origin);
});

test("buildPreMergeGateCheck passes with a carried marker and fails with an uncarried stale-head marker", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  const evidence = (pre) => ({ currentHeadSha: cur, draftGate: { visible: true, verdict: "clean" }, preApprovalGateMarker: { ...pre, sizeOutcome: "pass", sizeTouchesT1: false } });
  const carried = await carry(s, marker(origin), cur);
  assert.equal(buildPreMergeGateCheck(evidence(carried), 0).ok, true);
  assert.equal(buildPreMergeGateCheck(evidence(marker(origin)), 0).ok, false);
});

test("fetchDraftGateEvidence reads a base-only carry as current-head clean and a PR-own change as not clean", async () => {
  const s = setup();
  const origin = s.head();
  const cur = s.mergeBase("docs/a.md");
  s.git("update-ref", "refs/remotes/origin/main", "main");
  const body = renderGateReviewCommentBody({ gate: "draft_gate", headSha: origin, repo: REPO, verdict: "clean", findingsSummary: "none", nextAction: "mark ready for review" });
  const runChild = async (_cmd, args) => {
    if (args.some((a) => String(a).includes("issues/7/comments"))) return { code: 0, stdout: JSON.stringify([[{ id: 1, body, created_at: "2026-01-01T00:00:00Z" }]]), stderr: "" };
    if (args.includes("baseRefName")) return { code: 0, stdout: JSON.stringify({ baseRefName: "main" }), stderr: "" };
    return { code: 1, stdout: "", stderr: "unavailable" };
  };
  const read = (headSha) => fetchDraftGateEvidence({ repo: REPO, pr: 7, headSha }, { env: {}, ghCommand: "gh", runChild, repoRoot: s.dir });
  assert.equal((await read(cur)).currentHeadClean, true);
  s.put("src/x.mjs", "changed pr blob\n"); s.git("add", "-A"); s.git("commit", "-qm", "pr edit");
  assert.equal((await read(s.head())).currentHeadClean, false);
});
