#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import {
  summarizeHeadScopedCheckRunsSignal,
  normalizeHeadScopedCommitStatus,
  normalizeHeadScopedCiContract,
  partitionEntriesByCheckName,
  LOOP_DERIVED_CI_CHECK_NAMES,
  LOOP_DERIVED_CI_CHECK_NAME,
} from "@dev-loops/core/loop/copilot-ci-status";
import {
  DEFAULT_POLL_INTERVAL_MS,
  COPILOT_REVIEW_WAIT_TIMEOUT_MS,
} from "@dev-loops/core/loop/policy-constants";
import { ensureAsyncRunnerOwnership } from "../loop/_pr-runner-coordination.mjs";
import { resolveRepoRoot } from "../loop/_repo-root-resolver.mjs";

/** Maximum interval between heartbeat outputs during watch delays.
 *  Must be shorter than pi-subagents default needsAttentionAfterMs (60s). */
const WATCH_HEARTBEAT_MS = 45_000; // 45 seconds
const USAGE = `Usage: probe-ci-status.mjs --repo <owner/name> --pr <number> [--timeout-ms <n>] [--poll-interval-ms <n>]
Block-wait on a PR's combined CI check/status state (GitHub Actions + CircleCI +
any external commit-status / check-run) for the current head SHA, until terminal
or timeout. Provider-agnostic — unlike \`gh run watch\`, which is Actions-only.
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --pr <number>                 Pull request number
Optional:
  --timeout-ms <n>              Total watch budget (default 1800000; 0 = single check, no wait)
  --poll-interval-ms <n>        Delay between polls (default 60000)
Output (stdout, JSON):
  { "ok": true, "status": "success"|"failure"|"pending"|"timeout"|"changed"|"stuck",
    "settled": bool, "ciStatus": "success"|"failure"|"pending"|"none",
    "failedChecks": [{ "name": "...", "conclusion"?: "..." }], "headSha": "...", "attempts": N,
    "excludedFailureDetails": ["gate-evidence", ...] }
Statuses:
  success    Combined CI is green (or no checks present — see no-checks rule)
  failure    At least one check/status failed (failedChecks populated)
  pending    Timed-out single check (timeout-ms 0) found CI still in flight
  timeout    Watch budget elapsed while CI was still pending
  changed    Head SHA advanced during the wait; caller must re-baseline
  stuck      Zero-allocation stall bail (#1631): every check-run stayed QUEUED
             with zero jobs allocated (no runner picked up) and no other provider
             actively progressing (commit-status absent or already terminal, i.e.
             not pending) for ~5 min; treated as a stuck GitHub Actions queue and
             bailed early instead of burning the full watch budget
No-checks rule (grace, race-safe):
  Zero check-runs AND zero commit-statuses is NOT settled green on the first
  poll — a provider (CircleCI/Actions) may post its first check a beat after a
  fresh push, and settling early would report green before any CI ran. Instead
  the watcher awaits 2 consecutive zero-check polls (a ~2-poll-interval grace)
  before settling success (ciStatus "none"): a genuinely check-less repo still
  settles instead of hanging, while a late first check is awaited. If the PR's
  statusCheckRollup lists EXPECTED checks while the APIs still report zero, that
  is pending (checks expected, not yet reported), never none. A gh-api / parse
  failure is never treated as empty — it forces pending so the watch keeps
  polling, and a persistent error settles as "timeout", never fabricated green.
  (timeout-ms 0 single check has no waiting budget, so a clean no-checks head
  settles immediately.)
Diagnostic output (stderr):
  { "ok": true, "type": "watch_heartbeat", "elapsedMs": N, "totalBudgetMs": N, "poll": N, "maxPolls": N }
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseCiWatchCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "timeout-ms": { type: "string" },
      "poll-interval-ms": { type: "string" },
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
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: COPILOT_REVIEW_WAIT_TIMEOUT_MS,
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
    if (token.name === "timeout-ms") {
      options.timeoutMs = parseNonNegativeMs(requireTokenValue(token, parseError), "--timeout-ms");
      continue;
    }
    if (token.name === "poll-interval-ms") {
      options.pollIntervalMs = parsePositiveMs(requireTokenValue(token, parseError), "--poll-interval-ms");
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Watching CI requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

function parseNonNegativeMs(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw parseError(`${flag} must be a non-negative integer`);
  }
  return value;
}

function parsePositiveMs(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw parseError(`${flag} must be a positive integer`);
  }
  return value;
}

async function ghJson(ghCommand, args, env) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid JSON from gh: ${result.stdout.trim() || "<empty>"}`);
  }
}

function extractPrVisibleCheckNames(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup)) return [];
  return statusCheckRollup
    .map((entry) => entry?.name || entry?.context)
    .filter((name) => typeof name === "string" && name.length > 0);
}

// Failing commit-status contexts (state "failure"/"error"), e.g. CircleCI which
// reports through the status API rather than as check-runs.
function extractFailedStatusContexts(statuses) {
  if (!Array.isArray(statuses)) return [];
  return statuses
    .filter((s) => {
      const state = typeof s?.state === "string" ? s.state.toLowerCase() : "";
      return state === "failure" || state === "error";
    })
    .map((s) => ({
      name: typeof s?.context === "string" && s.context.length > 0 ? s.context : "unknown",
      conclusion: typeof s?.state === "string" ? s.state.toLowerCase() : "",
    }));
}

async function fetchPrHeadSha({ repo, pr }, { env, ghCommand }) {
  const payload = await ghJson(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,statusCheckRollup"],
    env,
  );
  const headSha = typeof payload.headRefOid === "string" ? payload.headRefOid.trim() : "";
  if (headSha.length === 0) {
    throw new Error("Missing required PR facts: headRefOid");
  }
  return { headSha, prVisibleCheckNames: extractPrVisibleCheckNames(payload.statusCheckRollup) };
}

/**
 * Read the combined check-runs + commit-status state for one head SHA.
 * Provider-agnostic: covers GitHub Actions, CircleCI, and any external
 * commit-status / check-run reported against the commit.
 *
 * `fetchError` is true when a `gh api` call failed (non-zero exit) or returned
 * an unparseable / malformed payload. The caller MUST NOT treat a fetchError as
 * a genuine empty (no-checks) state — a transient API error would otherwise
 * fabricate green. On fetchError, ciStatus is forced to "pending" so the watch
 * keeps polling (and a persistent error settles as "timeout", never success).
 *
 * @returns {{ ciStatus: "success"|"failure"|"pending"|"none", noChecks: boolean, fetchError: boolean, failedChecks: Array<{ name: string, conclusion?: string }>, excludedFailureDetails: Array<string> }}
 */
async function fetchHeadCiState({ repo, headSha, prVisibleCheckNames }, { env, ghCommand }) {
  const [checkRunsResult, statusesResult] = await Promise.all([
    runChild(ghCommand, ["api", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`], env),
    runChild(ghCommand, ["api", `repos/${repo}/commits/${headSha}/status?per_page=100`], env),
  ]);

  let checkRunsSignal = null;
  let checkRunsCount = 0;
  let checkRunsError = checkRunsResult.code !== 0;
  // Loop-derived gate-evidence exclusion (#1531): partition out
  // LOOP_DERIVED_CI_CHECK_NAMES (the gate-evidence status and the workflow's
  // own gate-evidence-runner check run) before computing the status, the same
  // way detect-copilot-loop-state.mjs does. The wait must not block on the
  // very derived signal the loop itself posts. A genuinely failing check
  // beside a red gate-evidence still blocks; the excluded entry stays visible
  // via excludedFailureDetails.
  let checkRunsExcludedFailureDetails = [];
  if (checkRunsResult.code === 0) {
    try {
      const payload = JSON.parse(checkRunsResult.stdout);
      if (Array.isArray(payload?.check_runs)) {
        const { matched: loopDerivedRuns, rest: nonLoopDerivedRuns } =
          partitionEntriesByCheckName(payload.check_runs, LOOP_DERIVED_CI_CHECK_NAMES);
        checkRunsExcludedFailureDetails =
          summarizeHeadScopedCheckRunsSignal({ check_runs: loopDerivedRuns }).status === "failure"
            ? [LOOP_DERIVED_CI_CHECK_NAME]
            : [];
        const visibleSet = prVisibleCheckNames?.length > 0 ? new Set(prVisibleCheckNames) : null;
        const visibleRuns = visibleSet
          ? nonLoopDerivedRuns.filter((run) => !run.name || visibleSet.has(run.name))
          : nonLoopDerivedRuns;
        const visibleSignal = summarizeHeadScopedCheckRunsSignal({ check_runs: visibleRuns });
        const fullSignal = summarizeHeadScopedCheckRunsSignal({ check_runs: nonLoopDerivedRuns });
        checkRunsSignal = {
          ...visibleSignal,
          unsupportedCompleted: fullSignal.unsupportedCompleted,
          allQueued: fullSignal.allQueued,
        };
        checkRunsCount = nonLoopDerivedRuns.length;
      } else {
        checkRunsError = true; // exit 0 but no check_runs array → malformed payload, not empty
      }
    } catch {
      checkRunsSignal = null;
      checkRunsError = true;
    }
  }

  let commitStatus = null;
  let statusesCount = 0;
  let statusFailures = [];
  let commitStatusExcludedFailureDetails = [];
  let statusesError = statusesResult.code !== 0;
  if (statusesResult.code === 0) {
    try {
      const payload = JSON.parse(statusesResult.stdout);
      if (Array.isArray(payload?.statuses)) {
        // Same gate-evidence exclusion mirrored for the commit-status API: the
        // gate-evidence StatusContext is the loop's own derived signal, so its
        // failure must not leak into commitStatus or failedChecks (#1531).
        const { matched: loopDerivedStatuses, rest: nonLoopDerivedStatuses } =
          partitionEntriesByCheckName(payload.statuses, LOOP_DERIVED_CI_CHECK_NAME);
        commitStatusExcludedFailureDetails =
          normalizeHeadScopedCommitStatus({ statuses: loopDerivedStatuses }) === "failure"
            ? [LOOP_DERIVED_CI_CHECK_NAME]
            : [];
        commitStatus = normalizeHeadScopedCommitStatus({ statuses: nonLoopDerivedStatuses });
        statusesCount = nonLoopDerivedStatuses.length;
        statusFailures = extractFailedStatusContexts(nonLoopDerivedStatuses);
      } else {
        statusesError = true; // exit 0 but no statuses array → malformed payload, not empty
      }
    } catch {
      commitStatus = null;
      statusesError = true;
    }
  }

  const fetchError = checkRunsError || statusesError;
  const ciStatus = fetchError
    ? "pending"
    : normalizeHeadScopedCiContract({
        checkRunsStatus: checkRunsSignal?.status ?? "none",
        commitStatus: commitStatus ?? "none",
        checkRunsUnsupportedCompleted: checkRunsSignal?.unsupportedCompleted ?? false,
      }).overallStatus;
  // Provider-agnostic failure reporting: check-runs failures AND failing
  // commit-status contexts (e.g. CircleCI reports via the status API with NO
  // check-runs). Without the status side, a CircleCI failure would surface
  // ciStatus "failure" with an empty failedChecks.
  const failedChecks = fetchError
    ? []
    : [
        ...(checkRunsSignal?.failureDetails ?? []).map((name) => ({ name })),
        ...statusFailures,
      ];
  const excludedFailureDetails = fetchError
    ? []
    : [...new Set([...checkRunsExcludedFailureDetails, ...commitStatusExcludedFailureDetails])];
  // No-checks: zero check-runs AND zero commit-statuses, observed cleanly (no
  // fetchError) AND with no PR-visible expected checks. If statusCheckRollup
  // lists expected checks the providers haven't reported yet, that is pending
  // (checks expected but not yet posted), not a genuinely check-less head.
  // The no-checks settle logic must also exclude loop-derived entries: a head
  // whose only checks are gate-evidence has no REAL CI to wait on, so it should
  // settle (after the grace window) rather than hang to timeout. prVisibleCheckNames
  // from the rollup includes gate-evidence, so filter it out here too (#1531).
  const nonLoopDerivedPrVisibleNames = prVisibleCheckNames?.filter(
    (name) => !LOOP_DERIVED_CI_CHECK_NAMES.includes(name),
  );
  const noChecks =
    !fetchError &&
    checkRunsCount === 0 &&
    statusesCount === 0 &&
    !(nonLoopDerivedPrVisibleNames?.length > 0);
  // Zero-allocation stall (#1631): at least one real check-run, ALL of them
  // still `queued` (no runner allocated / no job picked up), and no other
  // provider actively progressing — the stall qualifies only when the
  // commit-status is absent or already terminal (never pending). A commit-status
  // that already reached a terminal state (success/failure) or is absent means
  // nobody is making progress while GitHub Actions sits unallocated, so the
  // watcher bails after ZERO_ALLOCATION_STALL_BAIL_MS of observing this
  // instead of burning its full budget on a stuck queue. A run with any job
  // in_progress/completed, or another provider still pending, never qualifies.
  const allCheckRunsQueued =
    !fetchError &&
    checkRunsCount > 0 &&
    checkRunsSignal?.allQueued === true &&
    commitStatus !== "pending";
  return { ciStatus, noChecks, fetchError, failedChecks, excludedFailureDetails, allCheckRunsQueued };
}

function buildAttemptBudget(timeoutMs, pollIntervalMs) {
  if (timeoutMs === 0) {
    return 1;
  }
  // Polls land at t=0, interval, 2*interval, ... so floor(timeout/interval)+1
  // polls fit inside the budget (the first poll costs no delay).
  return Math.max(1, Math.floor(timeoutMs / pollIntervalMs) + 1);
}

// Attempt 1 polls immediately (t=0); attempt N waits (N-1)*pollIntervalMs from
// the watch start, capped by the total timeout budget.
function buildPollDelayMs(watchStartedAtMs, timeoutMs, pollIntervalMs, attempt, nowMs) {
  if (timeoutMs === 0 || attempt <= 1) {
    return 0;
  }
  const scheduledAtMs = watchStartedAtMs + Math.min(timeoutMs, (attempt - 1) * pollIntervalMs);
  return Math.max(0, scheduledAtMs - nowMs);
}

function settledResult(state, { settled, status }) {
  return {
    ok: true,
    status,
    settled,
    ciStatus: state.ciStatus,
    failedChecks: state.failedChecks,
    excludedFailureDetails: state.excludedFailureDetails ?? [],
    headSha: state.headSha,
    attempts: state.attempts,
  };
}

/** Consecutive clean zero-check polls required before settling none->success.
 *  A provider (CircleCI/Actions) may post its first check a beat after the push;
 *  settling on the FIRST zero-check poll would fabricate green before any CI ran.
 *  So we await this many consecutive zero-check observations (a grace of ~2 poll
 *  intervals) before treating a head as genuinely check-less. A repo that truly
 *  has no CI still settles after the grace instead of hanging to timeout. */
export const NO_CHECKS_GRACE_POLLS = 2;

/** Zero-allocation stall bail budget (#1631): when a CI run is QUEUED with zero
 *  jobs allocated (no runner picked up — every check-run still `queued`, no other
 *  provider actively progressing: commit-status absent or already terminal), the
 *  watcher bails after ~5 min instead of burning the full 30-min watch budget on
 *  a stuck GitHub Actions queue. A run that IS progressing (any check-run
 *  in_progress/completed, or another provider pending) is never bailed early. */
export const ZERO_ALLOCATION_STALL_BAIL_MS = 300_000; // ~5 minutes

/**
 * Map a head CI state to a terminal watcher status, or null when still in flight.
 * - failure / success classify immediately (a check is terminal).
 * - none (zero checks, clean fetch, no expected checks) settles success only
 *   after NO_CHECKS_GRACE_POLLS consecutive observations (see constant).
 * - fetchError / expected-but-unreported checks → pending (keep polling).
 */
function terminalStatusFor({ ciStatus, noChecks }, consecutiveNoChecks, graceFloor) {
  if (ciStatus === "failure") return "failure";
  if (ciStatus === "success") return "success";
  if (noChecks && consecutiveNoChecks >= graceFloor) return "success";
  return null;
}

export async function watchCiStatus(
  options,
  {
    env = process.env,
    ghCommand = "gh",
    delayImpl = delay,
    now = Date.now,
    ensureOwnershipImpl = ensureAsyncRunnerOwnership,
  } = {},
) {
  const leaseCwd = resolveRepoRoot(process.cwd());
  const { headSha: baselineSha, prVisibleCheckNames } = await fetchPrHeadSha(
    { repo: options.repo, pr: options.pr },
    { env, ghCommand },
  );
  const attemptBudget = buildAttemptBudget(options.timeoutMs, options.pollIntervalMs);
  const watchStartedAtMs = now();
  // timeout-ms 0 is a single live check with no waiting budget: there is no
  // grace window to await a late first check, so a clean no-checks head settles
  // immediately (preserves single-check semantics). A real watch awaits the grace.
  const graceFloor = options.timeoutMs === 0 ? 1 : NO_CHECKS_GRACE_POLLS;
  let consecutiveNoChecks = 0;
  // Zero-allocation stall bail (#1631): track the first poll that observed a
  // zero-allocation stall (all check-runs queued, no provider actively
  // progressing — commit-status absent or already terminal). The watcher
  // bails once the stall has persisted for stallBailMs instead of
  // burning the full watch budget on a stuck GitHub Actions queue.
  const stallBailMs = options.stallBailMs ?? ZERO_ALLOCATION_STALL_BAIL_MS;
  let stallStartedAtMs = null;
  for (let attempt = 1; attempt <= attemptBudget; attempt += 1) {
    // Attempt 1 polls at t=0 (CI may already be terminal); sleep only between
    // subsequent polls so the watcher never burns a full interval before its
    // first observation.
    if (attempt > 1) {
      const pollDelayMs = buildPollDelayMs(
        watchStartedAtMs,
        options.timeoutMs,
        options.pollIntervalMs,
        attempt,
        now(),
      );
      let remainingMs = pollDelayMs;
      while (remainingMs > 0) {
        const chunkMs = Math.min(WATCH_HEARTBEAT_MS, remainingMs);
        await delayImpl(chunkMs);
        remainingMs -= chunkMs;
        if (remainingMs > 0) {
          process.stderr.write(
            JSON.stringify({
              ok: true,
              type: "watch_heartbeat",
              elapsedMs: now() - watchStartedAtMs,
              totalBudgetMs: options.timeoutMs,
              poll: attempt,
              maxPolls: attemptBudget,
            }) + "\n",
          );
          // The blocking CI wait can span the full watch budget, which equals the
          // runner-coordination stale window; refresh the lease alongside each
          // heartbeat so the claim stays fresh for every caller of this engine.
          // No-ops without DEVLOOPS_RUN_ID; best-effort, never affects the watch.
          try {
            await ensureOwnershipImpl({
              repo: options.repo,
              pr: options.pr,
              env,
              cwd: leaseCwd,
              claimIfMissing: true,
              requireExisting: false,
            });
          } catch { /* best-effort: never affect the watch */ }
        }
      }
    }
    // Re-resolve the head SHA every poll: a new push must short-circuit to
    // "changed" so the caller re-baselines instead of waiting on a stale head.
    const { headSha: currentSha, prVisibleCheckNames: currentNames } = await fetchPrHeadSha(
      { repo: options.repo, pr: options.pr },
      { env, ghCommand },
    );
    if (currentSha !== baselineSha) {
      const changedState = await fetchHeadCiState(
        { repo: options.repo, headSha: currentSha, prVisibleCheckNames: currentNames },
        { env, ghCommand },
      );
      return settledResult({ ...changedState, headSha: currentSha, attempts: attempt }, {
        settled: false,
        status: "changed",
      });
    }
    // Use the per-poll currentNames (not the baseline): statusCheckRollup may
    // start empty and later populate expected checks for the SAME head SHA. With
    // the stale baseline names this head would look check-less and wrongly settle
    // none->success; currentNames keeps it pending until the checks report.
    const state = await fetchHeadCiState(
      { repo: options.repo, headSha: currentSha, prVisibleCheckNames: currentNames },
      { env, ghCommand },
    );
    consecutiveNoChecks = state.noChecks ? consecutiveNoChecks + 1 : 0;
    const terminal = terminalStatusFor(state, consecutiveNoChecks, graceFloor);
    if (terminal !== null) {
      return settledResult({ ...state, headSha: currentSha, attempts: attempt }, {
        settled: true,
        status: terminal,
      });
    }
    if (state.allCheckRunsQueued) {
      if (stallStartedAtMs === null) stallStartedAtMs = now();
      if (now() - stallStartedAtMs >= stallBailMs) {
        return settledResult({ ...state, headSha: currentSha, attempts: attempt }, {
          settled: false,
          status: "stuck",
        });
      }
    } else {
      stallStartedAtMs = null;
    }
  }
  // Budget exhausted while still pending. Re-resolve the head before the final
  // fetch: the head may have advanced during the last delay (short-circuit to
  // "changed" so the caller re-baselines), and the rollup may have populated
  // expected checks for the same SHA (use the current names, not baseline).
  // A zero-timeout single check reports the live "pending" state; a real watch
  // budget reports "timeout".
  const { headSha: finalSha, prVisibleCheckNames: finalNames } = await fetchPrHeadSha(
    { repo: options.repo, pr: options.pr },
    { env, ghCommand },
  );
  if (finalSha !== baselineSha) {
    const changedState = await fetchHeadCiState(
      { repo: options.repo, headSha: finalSha, prVisibleCheckNames: finalNames },
      { env, ghCommand },
    );
    return settledResult({ ...changedState, headSha: finalSha, attempts: attemptBudget }, {
      settled: false,
      status: "changed",
    });
  }
  const finalState = await fetchHeadCiState(
    { repo: options.repo, headSha: finalSha, prVisibleCheckNames: finalNames },
    { env, ghCommand },
  );
  return settledResult({ ...finalState, headSha: finalSha, attempts: attemptBudget }, {
    settled: false,
    status: options.timeoutMs === 0 ? "pending" : "timeout",
  });
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const options = parseCiWatchCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await watchCiStatus(options, { env, ghCommand });
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
