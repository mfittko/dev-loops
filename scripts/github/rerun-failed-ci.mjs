#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue,runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

export const SMOKE_JOB_NAMES = Object.freeze(["viewer-smoke", "deck-smoke", "article-smoke"]);
export const DEFAULT_MAX_ATTEMPTS = 3;
// GitHub never reports `timed_out` for an Actions job. A job past its timeout-minutes is `cancelled` with
// "The job has exceeded the maximum execution time of 20m0s"; a step past its timeout-minutes fails the job
// (`failure`) with "The action '<step>' has timed out after 10 minutes." Only the annotation tells a timeout apart.
const TIMEOUT_ANNOTATION = /has exceeded the maximum execution time|The action '.*' has timed out after|^The action has timed out\.$/;
// The `verify` aggregator (ci.yml, if: always()) fails whenever a smoke job fails; it is a dependent, never a cause.
const AGGREGATOR_JOB_NAME = "verify";
const HEAD_SHA = /^[0-9a-f]{40}$/;

/** True when the attempt is a positive integer below the cap; a missing or non-numeric attempt fails closed. */
export const isRerunnableAttempt = (attempt) => Number.isInteger(attempt) && attempt >= 1 && attempt < DEFAULT_MAX_ATTEMPTS;

// The failed names that decide smoke-only: the aggregator is ignored.
const causeNames = (names) => names.filter((name) => name !== AGGREGATOR_JOB_NAME);

/**
 * True when no failed check name is a non-smoke job: the cheap pre-filter before the live timeout read.
 * A lone failed `verify` passes: wait-pr-checks drops a `cancelled` job-timeout smoke job from failedChecks,
 * so only the live read (isSmokeTimeoutOnlyRun) can tell that shape apart from another verify failure.
 */
export function isSmokeOnly(failedChecks) {
  const names = Array.isArray(failedChecks) ? failedChecks.map((c) => c?.name) : [];
  return names.length > 0 && causeNames(names).every((name) => SMOKE_JOB_NAMES.includes(name));
}

// Wall-clock budget; the headroom under WAIT_CAP_MS (GATE-EXEC-BOUNDED-WAIT-CAP) covers the post-wait gh reads and the re-run call.
const WAIT_BUDGET_MS = 120_000;
const WAIT_INTERVAL_MS = 10_000;

/** Polls the head's ci.yml run until it is completed or the wall-clock budget ends; returns the last read. */
export async function waitForHeadCiRun(options, runtime = {}) {
  const { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, waitBudgetMs = WAIT_BUDGET_MS, waitIntervalMs = WAIT_INTERVAL_MS } = runtime;
  const startedAt = now();
  let run = await findHeadCiRun(options, runtime);
  while (run && run.status !== "completed" && now() - startedAt + waitIntervalMs <= waitBudgetMs) {
    await sleep(waitIntervalMs);
    run = await findHeadCiRun(options, runtime);
  }
  return run;
}

async function ghJson(args, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}, what) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) throw new Error(`Failed to read ${what}: ${result.stderr.trim() || `exit code ${result.code}`}`);
  return JSON.parse(result.stdout || "null");
}

/** The head's latest ci.yml run ({ databaseId, status, attempt }), or undefined when the head has none. */
export async function findHeadCiRun({ repo, headSha }, runtime = {}) {
  return (await ghJson(["run", "list", "--repo", repo, "--commit", headSha, "--workflow", "ci.yml", "--limit", "1", "--json", "databaseId,status,conclusion,attempt"], runtime, `CI runs for ${headSha}`) ?? [])[0];
}

/** True when the run has failed jobs and every one is a smoke job carrying a GitHub timeout annotation. */
export async function isSmokeTimeoutOnlyRun({ repo, runId }, runtime = {}) {
  const { jobs = [] } = await ghJson(["run", "view", String(runId), "--repo", repo, "--json", "jobs"], runtime, `jobs of CI run ${runId}`) ?? {};
  const failed = jobs.filter((job) => job?.conclusion === "failure" || job?.conclusion === "cancelled");
  const causes = failed.filter((job) => job.name !== AGGREGATOR_JOB_NAME);
  if (causes.length === 0 || !causes.every((job) => SMOKE_JOB_NAMES.includes(job.name))) return false;
  for (const job of causes) {
    const annotations = await ghJson(["api", `repos/${repo}/check-runs/${job.databaseId}/annotations?per_page=100`], runtime, `annotations of job ${job.databaseId}`) ?? [];
    if (!annotations.some((a) => a?.annotation_level === "failure" && TIMEOUT_ANNOTATION.test(a.message ?? ""))) return false;
  }
  return true;
}

const USAGE = `Usage: rerun-failed-ci.mjs --repo <owner/name> --head-sha <sha>
Sanctioned re-run of the failed jobs of a PR head's completed CI run
(gh run rerun --failed). Recovery for a timed-out smoke job (issue 3251).
Waits up to ${WAIT_BUDGET_MS / 1000}s for an in-progress run to complete (a red head does not end that run).
Refuses a run still in progress after the wait, a run whose failed jobs are not all
smoke jobs with a GitHub timeout annotation, and a run that has reached
attempt ${DEFAULT_MAX_ATTEMPTS}; the attempt count is the run's own attempt number.
Output (stdout, JSON): { "ok": true, "action": "rerun", "runId": N, "attempt": N }
Refusals (stderr JSON, exit 1): no_run, run_in_progress, run_succeeded, attempt_cap, not_smoke_timeout.
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Re-run requested
  1  Refusal, argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseRerunFailedCiCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, "head-sha": { type: "string" },...JQ_OUTPUT_PARSE_OPTIONS },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, repo: undefined, headSha: undefined };
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "head-sha") { options.headSha = requireTokenValue(token, parseError).trim(); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.repo || !options.headSha) throw parseError("rerun-failed-ci requires --repo and --head-sha");
  if (!HEAD_SHA.test(options.headSha)) throw parseError("--head-sha must be a full 40-character lowercase hex commit SHA");
  parseRepoSlug(options.repo);
  return options;
}

export async function rerunFailedCi(options, runtime = {}) {
  const { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = runtime;
  const run = await waitForHeadCiRun(options, runtime);
  if (!run) throw new Error(`no_run: no ci.yml run found for head ${options.headSha}`);
  if (run.status !== "completed") throw Object.assign(new Error(`run_in_progress: CI run ${run.databaseId} is still ${run.status} after waiting up to ${(runtime.waitBudgetMs ?? WAIT_BUDGET_MS) / 1000}s; run this script again to keep waiting`), { recovery: `dev-loops-run scripts/github/rerun-failed-ci.mjs --repo ${options.repo} --head-sha ${options.headSha}` });
  if (run.conclusion === "success") throw new Error(`run_succeeded: CI run ${run.databaseId} completed green with no failed job; run wait-pr-checks.mjs for a fresh read and do not emit a ci-failure fixer order`);
  if (!isRerunnableAttempt(run.attempt)) throw new Error(`attempt_cap: CI run ${run.databaseId} is at attempt ${run.attempt} of ${DEFAULT_MAX_ATTEMPTS}; emit the ci-failure fixer order instead`);
  if (!await isSmokeTimeoutOnlyRun({ repo: options.repo, runId: run.databaseId }, runtime)) throw new Error(`not_smoke_timeout: CI run ${run.databaseId} has a failed job that is not a timed-out smoke job; emit the ci-failure fixer order instead`);
  const rerun = await runChild(ghCommand, ["run", "rerun", String(run.databaseId), "--repo", options.repo, "--failed"], env);
  if (rerun.code !== 0) throw new Error(`Failed to re-run CI run ${run.databaseId}: ${rerun.stderr.trim() || `exit code ${rerun.code}`}`);
  return { ok: true, action: "rerun", runId: run.databaseId, attempt: run.attempt + 1 };
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const options = parseRerunFailedCiCliArgs(argv);
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  return emitResult(await rerunFailedCi(options, runtime), { jq: options.jq, silent: options.silent });
}

if (isDirectCliRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ...JSON.parse(formatCliError(error, { usage: USAGE })), ...(error.recovery ? { recovery: error.recovery } : {}) })}\n`);
    process.exitCode = 1;
  });
}
