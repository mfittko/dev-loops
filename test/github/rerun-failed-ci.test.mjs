import assert from "node:assert/strict";
import { test } from "bun:test";
import { makeGhMock } from "../_helpers.mjs";
import { isSmokeOnly, isSmokeTimeoutOnlyRun, parseRerunFailedCiCliArgs, rerunFailedCi } from "../../scripts/github/rerun-failed-ci.mjs";

// Annotation texts GitHub writes on a real timeout (issue 3251): a job past timeout-minutes concludes `cancelled`,
// a step past timeout-minutes fails the job with conclusion `failure`. GitHub never reports `timed_out` for a job.
const JOB_TIMEOUT = "The job has exceeded the maximum execution time of 20m0s";
const STEP_TIMEOUT = "The action 'Set up Playwright WebKit' has timed out after 10 minutes.";

const opts = { repo: "owner/repo", headSha: "a".repeat(40) };
const list = (over = {}) => ({ assertArgs: ["list"], stdout: JSON.stringify([{ databaseId: 99, status: "completed", attempt: 1, ...over }]) });
const jobs = (...entries) => ({ assertArgs: ["view", "99"], stdout: JSON.stringify({ jobs: [{ databaseId: 5, name: "build (24)", conclusion: "success" }, ...entries] }) });
const annotations = (id, message) => ({ assertArgs: ["api", `repos/owner/repo/check-runs/${id}/annotations`], stdout: JSON.stringify([{ annotation_level: "failure", message }, { annotation_level: "failure", message: "The operation was canceled." }]) });
const run = async (entries) => {
  const { runChild, calls } = makeGhMock(entries);
  return { calls, call: () => rerunFailedCi(opts, { env: {}, runChild }) };
};

test("re-runs the failed jobs of a completed run whose only failure is a timed-out smoke job", async () => {
  const { call, calls } = await run([list(), jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "cancelled" }), annotations(11, JOB_TIMEOUT), { assertArgs: ["rerun", "99", "--failed"], stdout: "" }]);
  assert.deepEqual(await call(), { ok: true, action: "rerun", runId: 99, attempt: 2 });
  assert.equal(calls.length, 4);
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

test("refuses a smoke failure without a timeout annotation, without a re-run call", async () => {
  const { call, calls } = await run([list(), jobs({ databaseId: 11, name: "deck-smoke", conclusion: "failure" }), annotations(11, "Process completed with exit code 1.")]);
  await assert.rejects(call(), /not_smoke_timeout/);
  assert.equal(calls.length, 3);
});

test("refuses when the head has no run", async () => {
  const { call } = await run([{ stdout: "[]" }]);
  await assert.rejects(call(), /no ci\.yml run/);
});

test("parses args and requires --repo and --head-sha", () => {
  assert.throws(() => parseRerunFailedCiCliArgs(["--repo", "o/r"]), /requires --repo and --head-sha/);
  assert.throws(() => parseRerunFailedCiCliArgs(["--repo", "o/r", "--head-sha", "abc", "--max-attempts", "2"]), /Unknown argument: --max-attempts/);
});

test("isSmokeOnly pre-filters on smoke job names", () => {
  assert.equal(isSmokeOnly([{ name: "viewer-smoke" }, { name: "deck-smoke" }]), true);
  assert.equal(isSmokeOnly([{ name: "viewer-smoke" }, { name: "build (24)" }]), false);
  assert.equal(isSmokeOnly([]), false);
});

test("isSmokeTimeoutOnlyRun reads the job and step timeout signals and rejects any other failed job", async () => {
  const check = (entries) => isSmokeTimeoutOnlyRun({ repo: "owner/repo", runId: 99 }, { env: {}, runChild: makeGhMock(entries).runChild });
  assert.equal(await check([jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "cancelled" }, { databaseId: 12, name: "article-smoke", conclusion: "failure" }), annotations(11, JOB_TIMEOUT), annotations(12, STEP_TIMEOUT)]), true);
  assert.equal(await check([jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "failure" }, { databaseId: 13, name: "lint", conclusion: "failure" })]), false);
  assert.equal(await check([jobs({ databaseId: 11, name: "viewer-smoke", conclusion: "cancelled" }), annotations(11, "The run was canceled by @someone.")]), false);
  assert.equal(await check([jobs()]), false);
});
