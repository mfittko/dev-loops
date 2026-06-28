#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const DEFAULT_TAIL_LINES = 200;

const USAGE = `Usage: fetch-ci-logs.mjs --repo <owner/name> --pr <number> [--failed-only] [--tail <n>]
Fetch the GitHub Actions CI run log tail for a PR's current head SHA. Thin wrapper
over \`gh run list\` + \`gh run view --log\` — use this instead of an agent-level raw
\`gh run view\` so the loop's internal-tooling record stays clean (#993). Complements
probe-ci-status.mjs, which reports failed-check NAMES; this returns the LOG tail.
(Siblings: list-issues.mjs, comment-issue.mjs.)
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --pr <number>                 Pull request number
Optional:
  --failed-only                 Only include runs whose conclusion is failure
                                (default: all Actions runs for the head SHA)
  --tail <n>                    Lines of log tail to return per run (default 200)
Output (stdout, JSON):
  { "ok": true, "repo": "owner/repo", "pr": 17, "headSha": "abc123",
    "runs": [{ "runId": 42, "name": "ci", "conclusion": "failure", "logTail": "..." }] }
Notes:
  Actions-only (gh run is GitHub Actions). CircleCI / external commit-status logs
  are NOT covered — use the provider's UI for those (probe-ci-status names the check).
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseFetchCiLogsCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "failed-only": { type: "boolean" },
      tail: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    failedOnly: false,
    tail: DEFAULT_TAIL_LINES,
    jq: undefined,
    silent: false,
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "failed-only") {
      options.failedOnly = true;
      continue;
    }
    if (token.name === "tail") {
      const raw = requireTokenValue(token, parseError);
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        throw parseError(`--tail must be a positive integer, got "${raw}"`);
      }
      options.tail = value;
      continue;
    }
    if (token.name === "jq") {
      options.jq = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "silent") {
      options.silent = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Fetching CI logs requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

async function ghJson(run, ghCommand, args, env, label) {
  const result = await run(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return parseJsonText(result.stdout, { label });
}

function tailLines(text, n) {
  const lines = String(text).replace(/\n$/u, "").split(/\r?\n/u);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

export async function fetchCiLogs(options, { env = process.env, ghCommand = "gh", run = runChild } = {}) {
  // 1. Resolve the PR's current head SHA — logs must be scoped to the head being
  //    evaluated, not a stale push.
  const pr = await ghJson(
    run,
    ghCommand,
    ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "headRefOid"],
    env,
    "gh pr view",
  );
  const headSha = typeof pr.headRefOid === "string" ? pr.headRefOid.trim() : "";
  if (headSha.length === 0) {
    throw new Error("gh pr view did not return headRefOid");
  }

  // 2. List Actions runs for that exact commit.
  const runs = await ghJson(
    run,
    ghCommand,
    ["run", "list", "--repo", options.repo, "--commit", headSha, "--json", "databaseId,name,conclusion,status"],
    env,
    "gh run list",
  );
  if (!Array.isArray(runs)) {
    throw new Error("gh run list did not return a JSON array");
  }
  const selected = options.failedOnly
    ? runs.filter((r) => String(r?.conclusion).toLowerCase() === "failure")
    : runs;

  // 3. Fetch each run's log tail. --log-failed restricts to failed steps when the
  //    run failed; for non-failed runs it returns nothing, so fall back to --log.
  const out = [];
  for (const r of selected) {
    const runId = Number.isInteger(r?.databaseId) ? r.databaseId : null;
    if (runId === null) continue;
    const conclusion = typeof r?.conclusion === "string" ? r.conclusion.toLowerCase() : null;
    const logFlag = conclusion === "failure" ? "--log-failed" : "--log";
    const logResult = await run(
      ghCommand,
      ["run", "view", String(runId), "--repo", options.repo, logFlag],
      env,
    );
    // A log fetch failure for one run shouldn't abort the others (logs expire);
    // record an empty tail with a note rather than throwing.
    const logTail =
      logResult.code === 0
        ? tailLines(logResult.stdout, options.tail)
        : `<log unavailable: ${logResult.stderr.trim() || `exit ${logResult.code}`}>`;
    out.push({
      runId,
      name: typeof r?.name === "string" ? r.name : null,
      conclusion,
      logTail,
    });
  }
  return { ok: true, repo: options.repo, pr: options.pr, headSha, runs: out };
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = runChild } = {},
) {
  let options;
  try {
    options = parseFetchCiLogsCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  let result;
  try {
    result = await fetchCiLogs(options, { env, ghCommand, run });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
