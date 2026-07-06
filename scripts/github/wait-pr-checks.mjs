#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import {
  DEFAULT_POLL_INTERVAL_MS,
  COPILOT_REVIEW_WAIT_TIMEOUT_MS,
} from "@dev-loops/core/loop/policy-constants";
// Reuse probe-ci-status.mjs's watch engine verbatim (polling, heartbeats, the
// not-yet-registered-check grace/race guard, head-change detection) instead of
// re-implementing it. This wrapper only adds seconds-based flags and a direct
// process-exit-code contract for shell/scripted callers.
import { watchCiStatus } from "./probe-ci-status.mjs";

const DEFAULT_TIMEOUT_SECONDS = Math.floor(COPILOT_REVIEW_WAIT_TIMEOUT_MS / 1000);
const DEFAULT_POLL_SECONDS = Math.floor(DEFAULT_POLL_INTERVAL_MS / 1000);

const USAGE = `Usage: wait-pr-checks.mjs --repo <owner/name> --pr <number> [--timeout <seconds>] [--poll <seconds>]
Block until the current head SHA's CI checks/statuses settle, or the wait
budget elapses. Replaces hand-rolled \`until [ "$(gh pr checks | grep -c pending)" = 0 ]\`
shell loops with a single deterministic call.
Required:
  --repo <owner/name>     Repository slug (e.g. owner/repo)
  --pr <number>           Pull request number
Optional:
  --timeout <seconds>     Total wait budget (default ${DEFAULT_TIMEOUT_SECONDS}; 0 = single
                          immediate check, no wait)
  --poll <seconds>        Delay between polls (default ${DEFAULT_POLL_SECONDS})
Not-yet-registered-check race guard:
  A freshly pushed head with zero registered checks does NOT settle green on
  the first poll — a provider may post its first check a beat after the push.
  The watcher requires either an observed check/status, or a stable empty
  result across two consecutive polls, before treating the head as genuinely
  check-less. A repo with no CI at all still settles after that grace instead
  of hanging to timeout.
Output (stdout, JSON, the final per-check summary):
  { "ok": true, "status": "success"|"failure"|"pending"|"timeout"|"changed",
    "settled": bool, "ciStatus": "success"|"failure"|"pending"|"none",
    "failedChecks": [{ "name": "...", "conclusion"?: "..." }], "headSha": "...", "attempts": N }
"changed" means the head SHA advanced during the wait; re-baseline and re-run.
Diagnostic output (stderr):
  { "ok": true, "type": "watch_heartbeat", "elapsedMs": N, "totalBudgetMs": N, "poll": N, "maxPolls": N }
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes (default output, no --jq/--silent):
  0  Green (status "success")
  1  Red (status "failure")
  2  Not settled (status "timeout"/"changed"/"pending") or an argument/gh error
With --jq/--silent, the standard jq-output contract above applies instead
(0/1 by result truthiness; 2 reserved for an invalid --jq filter).`.trim();

const parseError = buildParseError(USAGE);

function parseSecondsFlag(raw, flag, { allowZero }) {
  const value = Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) {
    throw parseError(`${flag} must be a${allowZero ? " non-negative" : " positive"} integer (seconds)`);
  }
  return value;
}

export function parseWaitPrChecksCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      timeout: { type: "string" },
      poll: { type: "string" },
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
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
    pollIntervalMs: DEFAULT_POLL_SECONDS * 1000,
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
    if (token.name === "timeout") {
      options.timeoutMs = parseSecondsFlag(requireTokenValue(token, parseError), "--timeout", { allowZero: true }) * 1000;
      continue;
    }
    if (token.name === "poll") {
      options.pollIntervalMs = parseSecondsFlag(requireTokenValue(token, parseError), "--poll", { allowZero: false }) * 1000;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Waiting on PR checks requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

// Direct process-exit-code contract for shell/scripted callers — this is the
// tool's reason to exist alongside `dev-loops loop watch-ci`, whose CLI always
// exits 0 and expects callers to branch on the JSON `status` field instead.
export function exitCodeForWaitResult(result) {
  if (result.status === "success") return 0;
  if (result.status === "failure") return 1;
  return 2;
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    ghCommand = "gh",
    delayImpl = undefined,
    now = undefined,
  } = {},
) {
  const options = parseWaitPrChecksCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const result = await watchCiStatus(
    { repo: options.repo, pr: options.pr, timeoutMs: options.timeoutMs, pollIntervalMs: options.pollIntervalMs },
    {
      env,
      ghCommand,
      ...(delayImpl ? { delayImpl } : {}),
      ...(now ? { now } : {}),
    },
  );
  if (options.jq !== undefined || options.silent) {
    return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr, ok: result.status === "success" });
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return exitCodeForWaitResult(result);
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => {
    if (typeof code === "number") {
      process.exitCode = code;
    }
  }).catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
