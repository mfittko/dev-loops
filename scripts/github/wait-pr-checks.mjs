#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { WAIT_CAP_MS, capWait, parseBaselineSha, pendingFields, resolveTimeoutMs, scriptCommand } from "../lib/timeout-flag.mjs";
import { parsePositiveInteger, parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
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
import { setTimeout as delay } from "node:timers/promises";
import { ghJson, isRateLimitError, rateLimitedResult, withGraphqlRateLimitWait } from "@dev-loops/core/github/gh";
import { waitWithHeartbeat } from "./_watch-heartbeat.mjs";
import { ensureAsyncRunnerOwnership } from "../loop/_pr-runner-coordination.mjs";
import { resolveRepoRoot } from "../loop/_repo-root-resolver.mjs";

const DEFAULT_TIMEOUT_SECONDS = Math.floor(COPILOT_REVIEW_WAIT_TIMEOUT_MS / 1000);
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 120_000;

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
                          immediate check, no wait; fractions allowed)
  --timeout-ms <n>        Deprecated alias for --timeout (milliseconds); warns on
                          stderr. Passing both flags fails closed.
  --poll <seconds>        Delay between polls (default ${DEFAULT_POLL_SECONDS})
One call waits at most ${WAIT_CAP_MS / 1000} seconds (GATE-EXEC-BOUNDED-WAIT-CAP). A longer --timeout
returns status "timeout" with outcome "pending" (exit 2) and a "reissue" command
carrying the remaining --timeout; run it.
Not-yet-registered-check race guard:
  A freshly pushed head with zero registered checks does NOT settle green on
  the first poll — a provider may post its first check a beat after the push.
  The watcher requires either an observed check/status, or a stable empty
  result across two consecutive polls, before treating the head as genuinely
  check-less. A repo with no CI at all still settles after that grace instead
  of hanging to timeout. Exception: when the GraphQL head read is rate limited,
  the head is read over REST, expected checks are unknown, and a check-less head
  stays pending (no grace settle).
Output (stdout, JSON, the final per-check summary):
  { "ok": true, "status": "success"|"failure"|"pending"|"timeout"|"changed"|"stuck",
    "settled": bool, "ciStatus": "success"|"failure"|"pending"|"none",
    "failedChecks": [{ "name": "...", "conclusion"?: "..." }], "headSha": "...", "attempts": N,
    "excludedFailureDetails": ["gate-evidence", ...] }
"changed" means the head SHA advanced during the wait; re-baseline and re-run.
"stuck" means a zero-allocation stall bail (#1631): every check-run stayed
QUEUED with zero jobs allocated for ~5 min; bailed early instead of the full
budget.
Diagnostic output (stderr):
  { "ok": true, "type": "watch_heartbeat", "elapsedMs": N, "totalBudgetMs": N, "poll": N, "maxPolls": N }
  { "ok": false, "error": "...", "usage"?: "..." }
Rate limit (JSON, exit 1):
  { "ok": false, "code": "RATE_LIMITED", "error": "...", "resetAt": "<ISO 8601>"|null,
    "budget": "primary_graphql"|"primary_core"|"secondary" }
For budget "secondary", resetAt is the earliest retry time the backoff computed (null when out of range), not a GitHub reset.
"budget" names the limit that was hit, read from \`gh api rate_limit\`: GraphQL
remaining 0 is "primary_graphql", core remaining 0 is "primary_core" (returned at
once with the core reset as resetAt), anything else is a "secondary" burst limit.
A rate limit is never reported as CI success or failure.
The RATE_LIMITED envelope is written to stdout when output is unfiltered, and
always to stderr.
A GraphQL limit alone switches the head read to REST and the watch continues
(see the race-guard exception). Only when the REST head read also fails does the
tool wait for the GraphQL reset inside the remaining --timeout budget
(heartbeats continue) and retry once, with budget "primary_graphql". A
GraphQL reset past the requested budget, or a core limit, returns RATE_LIMITED at once.
On a secondary limit the tool backs off and retries inside
--timeout: the delay is the exponential step, raised to the error's retry-after seconds
when that is longer (the step has jitter: ${BACKOFF_BASE_MS / 1000} s base, doubling, capped at ${BACKOFF_MAX_MS / 1000} s, each delay drawn from
50 to 100 percent of the step). A delay past the requested budget returns
RATE_LIMITED; a delay past the cap that fits the budget is returned like a reset
past the cap (see below). When the reset falls past this call's ~${WAIT_CAP_MS / 1000} s
cap but inside the requested budget, it sleeps within the cap and returns
status "timeout" with outcome "pending", ciStatus "pending", the baseline
headSha (null when none was read yet), "rateLimitResetAt" (ISO 8601) and a
"reissue" command; run that command unchanged. On a secondary limit the reissue
retries at once and starts a fresh backoff; rateLimitResetAt is advisory.
${JQ_OUTPUT_USAGE}
Exit codes (default output, no --jq/--silent):
  0  Green (status "success")
  1  Red (status "failure"), or an argument/gh/runtime error
  2  Not settled (status "timeout"/"changed"/"pending"/"stuck")
With --jq/--silent, the standard jq-output contract above applies instead
(0/1 by result truthiness; 2 reserved for an invalid --jq filter).`.trim();

const parseError = buildParseError(USAGE);

export function parseWaitPrChecksCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      timeout: { type: "string" },
      "timeout-ms": { type: "string" },
      poll: { type: "string" },
      "baseline-sha": { type: "string" },
      "stall-started-at-ms": { type: "string" },
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
  const rawTimeout = {};
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
    if (token.name === "timeout" || token.name === "timeout-ms") {
      rawTimeout[token.name === "timeout" ? "timeout" : "timeoutMs"] = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "poll") {
      options.pollIntervalMs = parsePositiveInteger(requireTokenValue(token, parseError), "--poll", parseError) * 1000;
      continue;
    }
    // Internal: a re-issued capped wait carries the first call's baseline head and stall start.
    if (token.name === "baseline-sha") {
      options.baselineSha = parseBaselineSha(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "stall-started-at-ms") {
      options.stallStartedAtMs = parsePositiveInteger(requireTokenValue(token, parseError), "--stall-started-at-ms", parseError);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  try {
    options.timeoutMs = resolveTimeoutMs(rawTimeout) ?? options.timeoutMs;
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
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
  if (result.ok === false) return 1;
  if (result.status === "success") return 0;
  if (result.status === "failure") return 1;
  return 2;
}

// An out-of-range time is an invalid Date whose toISOString throws; map it to null.
const isoOrNull = (ms) => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    ghCommand = "gh",
    delayImpl = delay,
    now = Date.now,
    runChild: runChildImpl = defaultRunChild,
    random = Math.random,
    ensureOwnershipImpl = ensureAsyncRunnerOwnership,
  } = {},
) {
  const requested = parseWaitPrChecksCliArgs(argv);
  if (requested.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  // One call waits at most the cap (GATE-EXEC-BOUNDED-WAIT-CAP); a longer request returns a pending result.
  const { timeoutMs: cappedMs, remainingMs: capRemainingMs } = capWait(requested.timeoutMs);
  const options = { ...requested, timeoutMs: cappedMs };
  // Remember the last rate-limit text gh printed: the shared wait helper rethrows its own message, which drops retry-after.
  let lastLimitText = "";
  const runChild = async (...args) => {
    const out = await runChildImpl(...args);
    if (out?.code !== 0 && isRateLimitError(out?.stderr ?? "")) lastLimitText = String(out.stderr);
    return out;
  };
  const startedAt = now();
  const remainingMs = () => options.timeoutMs - (now() - startedAt);
  let result;
  let isRetry = false;
  // The first watch's baseline head. The retry reuses it, so a push during the
  // reset wait returns "changed" instead of settling an un-baselined head.
  let baselineSha = options.baselineSha;
  let stallStartedAtMs = options.stallStartedAtMs;
  let pendingRemainingMs; // set by the rate-limit path; otherwise derived from actual elapsed time below
  // Refresh the runner lease during a reset wait, as the watch loop does between polls.
  const waitResetWithHeartbeat = (ms) => waitWithHeartbeat(ms, {
    attempt: 1, attemptBudget: 1, watchStartedAtMs: startedAt, timeoutMs: options.timeoutMs, now, delayImpl,
    onHeartbeat: () => ensureOwnershipImpl({
      repo: options.repo, pr: options.pr, env, cwd: resolveRepoRoot(process.cwd()), claimIfMissing: true, requireExisting: false,
    }),
  });
  let backoffStep = 0;
  for (;;) try {
    lastLimitText = "";
    result =await withGraphqlRateLimitWait(
      () => {
        // The retry after a rate-limit wait only gets the remaining budget. The
        // floor of 1 keeps it a real watch: timeoutMs 0 would switch to
        // single-check semantics and settle a no-checks head green at once.
        const timeoutMs = isRetry ? Math.max(1, remainingMs()) : options.timeoutMs;
        isRetry = true;
        return watchCiStatus(
          { repo: options.repo, pr: options.pr, timeoutMs, pollIntervalMs: capRemainingMs > 0 ? Math.min(options.pollIntervalMs, options.timeoutMs) : options.pollIntervalMs, baselineSha, stallStartedAtMs },
          {
            env, ghCommand, delayImpl, now, ensureOwnershipImpl, runChild,
            onBaseline: (sha) => { baselineSha = sha; },
            onStall: (startedAtMs) => { stallStartedAtMs = startedAtMs; },
          },
        );
      },
      {
        maxWaitMs: remainingMs,
        sleep: waitResetWithHeartbeat,
        now,
        env,
        ghCommand,
        runChild,
      },
    );
    break;
  } catch (error) {
    if (error?.code !== "RATE_LIMITED") throw error;
    const budgetLeftMs = requested.timeoutMs - (now() - startedAt);
    let budget = "secondary";
    let limits = null;
    try {
      limits = (await ghJson(["api", "rate_limit"], { env, ghCommand, runChild }))?.resources;
    } catch {
      // unreadable: treat as a secondary limit, which stays bounded by the budget
    }
    if (limits?.graphql?.remaining === 0) budget = "primary_graphql";
    else if (limits?.core?.remaining === 0) budget = "primary_core";
    if (budget === "primary_core") {
      const resetAt = Number.isFinite(limits.core.reset) ? isoOrNull(limits.core.reset * 1000) : null;
      result = { ...rateLimitedResult(Object.assign(new Error(`GitHub core rate limit exhausted; retry after ${resetAt ?? "unknown reset"}`), { resetAt })), budget };
      stderr.write(`${JSON.stringify(result)}\n`);
      break;
    }
    let resetAt = error.resetAt;
    let resetInMs = Date.parse(resetAt ?? "") - now();
    if (budget === "secondary") {
      // gh does not print retry-after today, so the plain exponential step applies unless the error text carries one.
      const retryAfter = /retry-after:?\s*(\d+)/i.exec(lastLimitText);
      const stepMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** backoffStep);
      resetInMs = Math.max(retryAfter ? Number(retryAfter[1]) * 1000 : 0, stepMs * (0.5 + random() * 0.5));
      backoffStep += 1;
      resetAt = isoOrNull(now() + resetInMs);
      if (resetInMs <= remainingMs()) {
        await waitResetWithHeartbeat(resetInMs);
        continue;
      }
    }
    if (capRemainingMs > 0 && resetInMs > 0 && resetInMs <= budgetLeftMs) {
      // The reset is past this call's cap but inside the requested budget: the re-issue waits it out.
      result = { ok: true, status: "timeout", settled: false, repo: options.repo, pr: options.pr, ciStatus: "pending", headSha: baselineSha ?? null, rateLimitResetAt: resetAt };
      // Sleep inside this call's cap first: a re-issue that hits the same limit at once would loop hot.
      await waitResetWithHeartbeat(Math.min(resetInMs, Math.max(0, options.timeoutMs - (now() - startedAt))));
      pendingRemainingMs = requested.timeoutMs - (now() - startedAt);
      break;
    } else {
      result = budget === "secondary"
        ? { ...rateLimitedResult(Object.assign(new Error(`GitHub secondary rate limit hit; earliest retry ${resetAt ?? "unknown"}`), { resetAt })), budget }
        : { ...rateLimitedResult(error), budget };
      // --jq/--silent would filter the envelope away; always keep code/resetAt on stderr.
      stderr.write(`${JSON.stringify(result)}\n`);
      break;
    }
  }
  pendingRemainingMs ??= capRemainingMs > 0 ? requested.timeoutMs - (now() - startedAt) : 0;
  if (result.status === "timeout" && pendingRemainingMs > 0) {
    const carry = { "--baseline-sha": baselineSha, "--stall-started-at-ms": stallStartedAtMs };
    result = { ...result, ...pendingFields({ remainingMs: pendingRemainingMs, command: scriptCommand(import.meta.url), argv, carry }) };
  }
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
