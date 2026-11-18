#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePositiveInteger, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

export const SMOKE_JOB_NAMES = Object.freeze(["viewer-smoke", "deck-smoke", "article-smoke"]);
export const DEFAULT_MAX_ATTEMPTS = 3;
// GitHub never reports `timed_out` for an Actions job. A job past its timeout-minutes is `cancelled` with
// "The job has exceeded the maximum execution time of 20m0s"; a step past its timeout-minutes fails the job
// (`failure`) with "The action '<step>' has timed out after 10 minutes." Only the annotation tells a timeout apart.
const TIMEOUT_ANNOTATION = /The job has exceeded the maximum execution time|The action '.*' has timed out after/;

/** True when every failed check name is a smoke job: the cheap pre-filter before the live timeout read. */
export function isSmokeOnly(failedChecks) {
  return Array.isArray(failedChecks) && failedChecks.length > 0 && failedChecks.every((c) => SMOKE_JOB_NAMES.includes(c?.name));
}

async function ghJson(args, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}, what) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) throw new Error(`Failed to read ${what}: ${result.stderr.trim() || `exit code ${result.code}`}`);
  return JSON.parse(result.stdout || "null");
}

/** The head's latest ci.yml run ({ databaseId, status, attempt }), or undefined when the head has none. */
export async function findHeadCiRun({ repo, headSha }, runtime = {}) {
  return (await ghJson(["run", "list", "--repo", repo, "--commit", headSha, "--workflow", "ci.yml", "--limit", "1", "--json", "databaseId,status,attempt"], runtime, `CI runs for ${headSha}`) ?? [])[0];
}

/** True when the run has failed jobs and every one is a smoke job carrying a GitHub timeout annotation. */
export async function isSmokeTimeoutOnlyRun({ repo, runId }, runtime = {}) {
  const { jobs = [] } = await ghJson(["run", "view", String(runId), "--repo", repo, "--json", "jobs"], runtime, `jobs of CI run ${runId}`) ?? {};
  const failed = jobs.filter((job) => job?.conclusion === "failure" || job?.conclusion === "cancelled");
  if (failed.length === 0 || !failed.every((job) => SMOKE_JOB_NAMES.includes(job.name))) return false;
  for (const job of failed) {
    const annotations = await ghJson(["api", `repos/${repo}/check-runs/${job.databaseId}/annotations`], runtime, `annotations of job ${job.databaseId}`) ?? [];
    if (!annotations.some((a) => a?.annotation_level === "failure" && TIMEOUT_ANNOTATION.test(a.message ?? ""))) return false;
  }
  return true;
}

const USAGE = `Usage: rerun-failed-ci.mjs --repo <owner/name> --head-sha <sha> [--max-attempts <n>]
Sanctioned re-run of the failed jobs of a PR head's completed CI run
(gh run rerun --failed). Recovery for a timed-out smoke job (issue 3251).
Refuses a run that is still in progress, a run whose failed jobs are not all
smoke jobs with a GitHub timeout annotation, and a run that has reached
--max-attempts attempts (default ${DEFAULT_MAX_ATTEMPTS}); the attempt count is the run's own attempt number.
Output (stdout, JSON): { "ok": true, "action": "rerun", "runId": N, "attempt": N }
Refusals (stderr JSON, exit 1): no run, run_in_progress, attempt_cap, not_smoke_timeout.
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Re-run requested
  1  Refusal, argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseRerunFailedCiCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, "head-sha": { type: "string" }, "max-attempts": { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, repo: undefined, headSha: undefined, maxAttempts: DEFAULT_MAX_ATTEMPTS };
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "head-sha") { options.headSha = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "max-attempts") { options.maxAttempts = parsePositiveInteger(requireTokenValue(token, parseError), parseError); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.repo || !options.headSha) throw parseError("rerun-failed-ci requires --repo and --head-sha");
  parseRepoSlug(options.repo);
  return options;
}

export async function rerunFailedCi(options, runtime = {}) {
  const { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = runtime;
  const run = await findHeadCiRun(options, runtime);
  if (!run) throw new Error(`no ci.yml run found for head ${options.headSha}`);
  if (run.status !== "completed") throw new Error(`run_in_progress: CI run ${run.databaseId} is ${run.status}; wait for it with scripts/github/wait-pr-checks.mjs, then retry`);
  if (run.attempt >= options.maxAttempts) throw new Error(`attempt_cap: CI run ${run.databaseId} is at attempt ${run.attempt} of ${options.maxAttempts}; stop re-running and escalate`);
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
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
  });
}
