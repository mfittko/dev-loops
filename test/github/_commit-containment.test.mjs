import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildContainmentMap, isCommitContainedByHead } from "../../scripts/github/_commit-containment.mjs";

const REPO = "owner/repo";
const COMMIT_SHA = "abc1234def5670000000000000000000000000000";
const HEAD_SHA = "fedcba9876540000000000000000000000000000";

function stubRunChild({ code = 0, stdout = "{}\n", stderr = "" } = {}, { throwError } = {}) {
  return async () => {
    if (throwError) throw throwError;
    return { code, stdout, stderr };
  };
}

test("isCommitContainedByHead: identical status is contained", async () => {
  const result = await isCommitContainedByHead(
    { repo: REPO, commitSha: COMMIT_SHA, headSha: HEAD_SHA },
    { runChild: stubRunChild({ stdout: `${JSON.stringify({ status: "identical" })}\n` }) },
  );
  assert.equal(result.contained, true);
});

test("isCommitContainedByHead: ahead status (commit is an ancestor of head) is contained", async () => {
  const result = await isCommitContainedByHead(
    { repo: REPO, commitSha: COMMIT_SHA, headSha: HEAD_SHA },
    { runChild: stubRunChild({ stdout: `${JSON.stringify({ status: "ahead" })}\n` }) },
  );
  assert.equal(result.contained, true);
});

test("isCommitContainedByHead: behind status (head is an ancestor of commit — commit not yet on head) is NOT contained", async () => {
  const result = await isCommitContainedByHead(
    { repo: REPO, commitSha: COMMIT_SHA, headSha: HEAD_SHA },
    { runChild: stubRunChild({ stdout: `${JSON.stringify({ status: "behind" })}\n` }) },
  );
  assert.equal(result.contained, false);
  assert.match(result.reason, /not contained/);
});

test("isCommitContainedByHead: diverged status is NOT contained", async () => {
  const result = await isCommitContainedByHead(
    { repo: REPO, commitSha: COMMIT_SHA, headSha: HEAD_SHA },
    { runChild: stubRunChild({ stdout: `${JSON.stringify({ status: "diverged" })}\n` }) },
  );
  assert.equal(result.contained, false);
});

test("isCommitContainedByHead: fails closed (not contained, retryable) on a non-zero gh exit", async () => {
  const result = await isCommitContainedByHead(
    { repo: REPO, commitSha: COMMIT_SHA, headSha: HEAD_SHA },
    { runChild: stubRunChild({ code: 1, stdout: "", stderr: "rate limited" }) },
  );
  assert.equal(result.contained, false);
  assert.equal(result.retryable, true);
  assert.match(result.reason, /rate limited/);
});

test("isCommitContainedByHead: fails closed on unparseable JSON", async () => {
  const result = await isCommitContainedByHead(
    { repo: REPO, commitSha: COMMIT_SHA, headSha: HEAD_SHA },
    { runChild: stubRunChild({ stdout: "not json" }) },
  );
  assert.equal(result.contained, false);
  assert.equal(result.retryable, true);
});

test("isCommitContainedByHead: fails closed when runChild throws (e.g. timeout)", async () => {
  const result = await isCommitContainedByHead(
    { repo: REPO, commitSha: COMMIT_SHA, headSha: HEAD_SHA },
    { runChild: stubRunChild({}, { throwError: new Error("timeout") }) },
  );
  assert.equal(result.contained, false);
  assert.equal(result.retryable, true);
  assert.match(result.reason, /timeout/);
});

test("isCommitContainedByHead: fails closed on an unexpected status value", async () => {
  const result = await isCommitContainedByHead(
    { repo: REPO, commitSha: COMMIT_SHA, headSha: HEAD_SHA },
    { runChild: stubRunChild({ stdout: `${JSON.stringify({ status: "weird" })}\n` }) },
  );
  assert.equal(result.contained, false);
  assert.equal(result.retryable, true);
});

test("buildContainmentMap: computes containment for each unique commit sha", async () => {
  const calls = [];
  const runChild = async (cmd, args) => {
    calls.push(args);
    const sha = args[1].split("/compare/")[1].split("...")[0];
    const status = sha === COMMIT_SHA ? "ahead" : "diverged";
    return { code: 0, stdout: `${JSON.stringify({ status })}\n`, stderr: "" };
  };
  const map = await buildContainmentMap([COMMIT_SHA, "0000000000000000000000000000000000000000"], { repo: REPO, headSha: HEAD_SHA }, { runChild });
  assert.equal(map[COMMIT_SHA], true);
  assert.equal(map["0000000000000000000000000000000000000000"], false);
  assert.equal(calls.length, 2);
});
