import assert from "node:assert/strict";
import { test } from "bun:test";
import { makeGhMock } from "../_helpers.mjs";
import { DEFAULT_MAX_ATTEMPTS, isRerunnableAttempt, isSmokeOnly, isSmokeTimeoutOnlyRun, parseRerunFailedCiCliArgs, rerunFailedCi } from "../../scripts/github/rerun-failed-ci.mjs";

// Annotation texts GitHub writes on a real timeout (issue 3251): a job past timeout-minutes concludes `cancelled`,
// a step past timeout-minutes fails the job with conclusion `failure`. GitHub never reports `timed_out` for a job.
const JOB_TIMEOUT = "The job has exceeded the maximum execution time of 20m0s";
const RUNNER_JOB_TIMEOUT = "The job running on runner GitHub Actions 2 has exceeded the maximum execution time of 45 minutes.";
const STEP_TIMEOUT = "The action 'Set up Playwright WebKit' has timed out after 10 minutes.";

const opts = { repo: "owner/repo", headSha: "a".repeat(40) };
const list = (over = {}) => ({ assertArgs: ["list"], stdout: JSON.stringify([{ databaseId: 99, status: "completed", attempt: 1, ...over }]) });
const jobs = (...entries) => ({ assertArgs: ["view", "99"], stdout: JSON.stringify({ jobs: [{ databaseId: 5, name: "build (24)", conclusion: "success" }, ...entries] }) });
const annotations = (id, message) => ({ assertArgs: ["api", `repos/owner/repo/check-runs/${id}/annotations?per_page=100`], stdout: JSON.stringify([{ annotation_level: "failure", message }, { annotation_level: "failure", message: "The operation was canceled." }]) });
const verifyFailed = { databaseId: 20, name: "verify", conclusion: "failure" };
const run = async (entries) => {
  const { runChild, calls } = makeGhMock(entries);
  return { calls, call: () => rerunFailedCi(opts, { env: {}, runChild, sleep: async () => {}, waitBudgetMs: 10_000, waitIntervalMs: 10_000 }) };
};

test("re-runs the failed jobs of a completed run whose only failure is a timed-out smoke job", async () => {
  const { call, calls } = await run([list(), jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "cancelled" }), annotations(11, JOB_TIMEOUT), { assertArgs: ["rerun", "99", "--failed"], stdout: "" }]);
  assert.deepEqual(await call(), { ok: true, action: "rerun", runId: 99, attempt: 2 });
  assert.equal(calls.length, 4);
});

test("the verify aggregator failing beside a timed-out smoke job still re-runs, and its annotations are never read", async () => {
  const { call, calls } = await run([list(), jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "cancelled" }, verifyFailed), annotations(11, RUNNER_JOB_TIMEOUT), { assertArgs: ["rerun", "99", "--failed"], stdout: "" }]);
  assert.deepEqual(await call(), { ok: true, action: "rerun", runId: 99, attempt: 2 });
  assert.equal(calls.length, 4);
});

test("refuses a run still in progress after the bounded wait, without a re-run call", async () => {
  const { call, calls } = await run([list({ status: "in_progress" }), list({ status: "in_progress" })]);
  await assert.rejects(call(), /run_in_progress.*run this script again/);
  assert.equal(calls.length, 2);
});

test("waits for an in-progress run to complete, then re-runs its timed-out smoke job", async () => {
  const { call, calls } = await run([list({ status: "in_progress" }), list(), jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "failure" }), annotations(11, STEP_TIMEOUT), { assertArgs: ["rerun", "99", "--failed"], stdout: "" }]);
  assert.deepEqual(await call(), { ok: true, action: "rerun", runId: 99, attempt: 2 });
  assert.equal(calls.length, 5);
});

test("refuses at the per-head attempt cap, without a re-run call", async () => {
  const { call, calls } = await run([list({ attempt: 3 })]);
  await assert.rejects(call(), /attempt_cap/);
  assert.equal(calls.length, 1);
});

test("refuses a run with no numeric attempt, without a re-run call", async () => {
  const { call, calls } = await run([{ assertArgs: ["list"], stdout: JSON.stringify([{ databaseId: 99, status: "completed" }]) }]);
  await assert.rejects(call(), /attempt_cap/);
  assert.equal(calls.length, 1);
});

test("the attempt predicate accepts 1 and 2 and fails closed on the cap, zero and non-numeric values", () => {
  for (const attempt of [1, 2]) assert.equal(isRerunnableAttempt(attempt), true, String(attempt));
  for (const attempt of [DEFAULT_MAX_ATTEMPTS, 4, undefined, null, "2", 0]) assert.equal(isRerunnableAttempt(attempt), false, String(attempt));
});

test("refuses a smoke failure without a timeout annotation, without a re-run call", async () => {
  const { call, calls } = await run([list(), jobs({ databaseId: 11, name: "deck-smoke", conclusion: "failure" }), annotations(11, "Process completed with exit code 1.")]);
  await assert.rejects(call(), /not_smoke_timeout/);
  assert.equal(calls.length, 3);
});

test("refuses when the head has no run, with the stable no_run token", async () => {
  const { call } = await run([{ stdout: "[]" }]);
  await assert.rejects(call(), /^Error: no_run: no ci\.yml run/);
});

test("parses args, requires --repo and --head-sha, and rejects a head that is not a full 40-hex SHA", () => {
  const sha = "a".repeat(40);
  assert.throws(() => parseRerunFailedCiCliArgs(["--repo", "o/r"]), /requires --repo and --head-sha/);
  assert.throws(() => parseRerunFailedCiCliArgs(["--repo", "o/r", "--head-sha", sha, "--max-attempts", "2"]), /Unknown argument: --max-attempts/);
  assert.equal(parseRerunFailedCiCliArgs(["--repo", "o/r", "--head-sha", sha]).headSha, sha);
  for (const bad of ["abc123", `${sha}XX`]) assert.throws(() => parseRerunFailedCiCliArgs(["--repo", "o/r", "--head-sha", bad]), /full 40-character/, bad);
});

test("isSmokeOnly pre-filters on smoke job names and ignores a failed verify aggregator beside a smoke failure", () => {
  const names = (...n) => n.map((name) => ({ name }));
  for (const accepted of [["viewer-smoke"], ["viewer-smoke", "deck-smoke"], ["viewer-smoke", "verify"], ["deck-smoke", "article-smoke", "verify"], ["verify"]]) assert.equal(isSmokeOnly(names(...accepted)), true, accepted.join());
  for (const rejected of [["viewer-smoke", "build (24)"], ["verify-suite", "verify"], ["viewer-smoke", "verify-suite", "verify"], []]) assert.equal(isSmokeOnly(names(...rejected)), false, rejected.join());
});

test("isSmokeTimeoutOnlyRun reads the job and step timeout signals and rejects any other failed job", async () => {
  const check = (entries) => isSmokeTimeoutOnlyRun({ repo: "owner/repo", runId: 99 }, { env: {}, runChild: makeGhMock(entries).runChild });
  assert.equal(await check([jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "cancelled" }, { databaseId: 12, name: "article-smoke", conclusion: "failure" }), annotations(11, JOB_TIMEOUT), annotations(12, STEP_TIMEOUT)]), true);
  assert.equal(await check([jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "failure" }, { databaseId: 13, name: "lint", conclusion: "failure" })]), false);
  assert.equal(await check([jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "cancelled" }), annotations(11, "The run was canceled by @someone.")]), false);
  assert.equal(await check([jobs()]), false);
  // verify fails with a non-smoke job, or alone: never a smoke timeout.
  assert.equal(await check([jobs({ databaseId: 13, name: "verify-suite", conclusion: "failure" }, verifyFailed)]), false);
  assert.equal(await check([jobs(verifyFailed)]), false);
});

test("the timeout matcher accepts the runner-named job timeout and rejects non-timeout annotations", async () => {
  const check = (message) => isSmokeTimeoutOnlyRun({ repo: "owner/repo", runId: 99 }, { env: {}, runChild: makeGhMock([jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "cancelled" }), annotations(11, message)]).runChild });
  for (const message of [JOB_TIMEOUT, RUNNER_JOB_TIMEOUT, STEP_TIMEOUT]) assert.equal(await check(message), true, message);
  for (const message of ["Process completed with exit code 1.", "The operation was canceled.", ""]) assert.equal(await check(message), false, message);
});
