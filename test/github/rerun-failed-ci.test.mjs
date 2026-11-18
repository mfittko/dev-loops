import assert from "node:assert/strict";
import { test } from "bun:test";
import { makeGhMock } from "../_helpers.mjs";
import { isSmokeTimeoutOnly, parseRerunFailedCiCliArgs, rerunFailedCi } from "../../scripts/github/rerun-failed-ci.mjs";

const opts = { repo: "owner/repo", headSha: "a".repeat(40), maxAttempts: 3 };
const list = (over = {}) => ({ assertArgs: ["list"], stdout: JSON.stringify([{ databaseId: 99, status: "completed", attempt: 1, ...over }]) });
const run = async (entries) => {
  const { runChild, calls } = makeGhMock(entries);
  return { calls, call: () => rerunFailedCi(opts, { env: {}, runChild }) };
};

test("re-runs the failed jobs of a completed run", async () => {
  const { call, calls } = await run([list(), { assertArgs: ["rerun", "99", "--failed"], stdout: "" }]);
  assert.deepEqual(await call(), { ok: true, action: "rerun", runId: 99, attempt: 2 });
  assert.equal(calls.length, 2);
});

test("refuses a run that is still in progress, without a re-run call", async () => {
  const { call, calls } = await run([list({ status: "in_progress" })]);
  await assert.rejects(call(), /run_in_progress/);
  assert.equal(calls.length, 1);
});

test("refuses at the per-head attempt cap, without a re-run call", async () => {
  const { call, calls } = await run([list({ attempt: 3 })]);
  await assert.rejects(call(), /attempt_cap/);
  assert.equal(calls.length, 1);
});

test("refuses when the head has no run", async () => {
  const { call } = await run([{ stdout: "[]" }]);
  await assert.rejects(call(), /no ci\.yml run/);
});

test("parses args and requires --repo and --head-sha", () => {
  assert.throws(() => parseRerunFailedCiCliArgs(["--repo", "o/r"]), /requires --repo and --head-sha/);
  assert.equal(parseRerunFailedCiCliArgs(["--repo", "o/r", "--head-sha", "abc", "--max-attempts", "2"]).maxAttempts, 2);
});

test("isSmokeTimeoutOnly routes only timed-out smoke jobs", () => {
  const t = (name, conclusion = "timed_out") => ({ name, conclusion });
  assert.equal(isSmokeTimeoutOnly([t("viewer-smoke"), t("deck-smoke")]), true);
  assert.equal(isSmokeTimeoutOnly([t("viewer-smoke"), t("build (24)")]), false);
  assert.equal(isSmokeTimeoutOnly([t("viewer-smoke", "failure")]), false);
  assert.equal(isSmokeTimeoutOnly([]), false);
});
