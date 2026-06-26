#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  summarizeHeadScopedCheckRunsSignal,
  normalizeHeadScopedCommitStatus,
  normalizeHeadScopedCiContract,
} from "@dev-loops/core/loop/copilot-ci-status";
import {
  DEFAULT_POLL_INTERVAL_MS,
  COPILOT_REVIEW_WAIT_TIMEOUT_MS,
} from "@dev-loops/core/loop/policy-constants";

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
  { "ok": true, "status": "success"|"failure"|"pending"|"timeout"|"changed",
    "settled": bool, "ciStatus": "success"|"failure"|"pending"|"none",
    "failedChecks": [{ "name": "..." }], "headSha": "...", "attempts": N }
Statuses:
  success    Combined CI is green (or no checks present — see no-checks rule)
  failure    At least one check/status failed (failedChecks populated)
  pending    Timed-out single check (timeout-ms 0) found CI still in flight
  timeout    Watch budget elapsed while CI was still pending
  changed    Head SHA advanced during the wait; caller must re-baseline
No-checks rule:
  When the head SHA has zero check-runs AND zero commit-statuses, CI is
  treated as settled success (ciStatus "none") immediately — there is
  nothing to wait on, so the watcher must not hang.
Diagnostic output (stderr):
  { "ok": true, "type": "watch_heartbeat", "elapsedMs": N, "totalBudgetMs": N, "poll": N, "maxPolls": N }
  { "ok": false, "error": "...", "usage"?: "..." }
Exit codes:
  0  Success
  1  Argument error or gh failure`.trim();
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
 * @returns {{ ciStatus: "success"|"failure"|"pending"|"none", noChecks: boolean, failedChecks: Array<{name:string}> }}
 */
async function fetchHeadCiState({ repo, headSha, prVisibleCheckNames }, { env, ghCommand }) {
  const [checkRunsResult, statusesResult] = await Promise.all([
    runChild(ghCommand, ["api", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`], env),
    runChild(ghCommand, ["api", `repos/${repo}/commits/${headSha}/status?per_page=100`], env),
  ]);

  let checkRunsSignal = null;
  let checkRunsCount = 0;
  if (checkRunsResult.code === 0) {
    try {
      const payload = JSON.parse(checkRunsResult.stdout);
      if (Array.isArray(payload?.check_runs)) {
        const visibleSet = prVisibleCheckNames?.length > 0 ? new Set(prVisibleCheckNames) : null;
        const visibleRuns = visibleSet
          ? payload.check_runs.filter((run) => !run.name || visibleSet.has(run.name))
          : payload.check_runs;
        const visibleSignal = summarizeHeadScopedCheckRunsSignal({ check_runs: visibleRuns });
        const fullSignal = summarizeHeadScopedCheckRunsSignal(payload);
        checkRunsSignal = { ...visibleSignal, unsupportedCompleted: fullSignal.unsupportedCompleted };
        checkRunsCount = payload.check_runs.length;
      }
    } catch {
      checkRunsSignal = null;
    }
  }

  let commitStatus = null;
  let statusesCount = 0;
  if (statusesResult.code === 0) {
    try {
      const payload = JSON.parse(statusesResult.stdout);
      if (Array.isArray(payload?.statuses)) {
        commitStatus = normalizeHeadScopedCommitStatus(payload);
        statusesCount = payload.statuses.length;
      }
    } catch {
      commitStatus = null;
    }
  }

  const ciStatus = normalizeHeadScopedCiContract({
    checkRunsStatus: checkRunsSignal?.status ?? "none",
    commitStatus: commitStatus ?? "none",
    checkRunsUnsupportedCompleted: checkRunsSignal?.unsupportedCompleted ?? false,
  }).overallStatus;
  const failedChecks = (checkRunsSignal?.failureDetails ?? []).map((name) => ({ name }));
  return {
    ciStatus,
    // No-checks rule: zero check-runs AND zero commit-statuses on the head SHA.
    noChecks: checkRunsCount === 0 && statusesCount === 0,
    failedChecks,
  };
}

function buildAttemptBudget(timeoutMs, pollIntervalMs) {
  if (timeoutMs === 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
}

function buildPollDelayMs(watchStartedAtMs, timeoutMs, pollIntervalMs, attempt, nowMs) {
  if (timeoutMs === 0) {
    return 0;
  }
  const scheduledAtMs = watchStartedAtMs + Math.min(timeoutMs, attempt * pollIntervalMs);
  return Math.max(0, scheduledAtMs - nowMs);
}

function settledResult(state, { settled, status }) {
  return {
    ok: true,
    status,
    settled,
    ciStatus: state.ciStatus,
    failedChecks: state.failedChecks,
    headSha: state.headSha,
    attempts: state.attempts,
  };
}

/**
 * Map a head CI state to a terminal watcher status, or null when still in flight.
 * No-checks settles as success — there is nothing to wait on.
 */
function terminalStatusFor({ ciStatus, noChecks }) {
  if (ciStatus === "failure") return "failure";
  if (ciStatus === "success") return "success";
  if (noChecks) return "success";
  return null;
}

export async function watchCiStatus(
  options,
  {
    env = process.env,
    ghCommand = "gh",
    delayImpl = delay,
    now = Date.now,
  } = {},
) {
  const { headSha: baselineSha, prVisibleCheckNames } = await fetchPrHeadSha(
    { repo: options.repo, pr: options.pr },
    { env, ghCommand },
  );
  const attemptBudget = buildAttemptBudget(options.timeoutMs, options.pollIntervalMs);
  const watchStartedAtMs = now();
  for (let attempt = 1; attempt <= attemptBudget; attempt += 1) {
    if (!(options.timeoutMs === 0 && attempt === 1)) {
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
    const state = await fetchHeadCiState(
      { repo: options.repo, headSha: currentSha, prVisibleCheckNames },
      { env, ghCommand },
    );
    const terminal = terminalStatusFor(state);
    if (terminal !== null) {
      return settledResult({ ...state, headSha: currentSha, attempts: attempt }, {
        settled: true,
        status: terminal,
      });
    }
  }
  // Budget exhausted while still pending. A zero-timeout single check reports
  // the live "pending" state; a real watch budget reports "timeout".
  const finalState = await fetchHeadCiState(
    { repo: options.repo, headSha: baselineSha, prVisibleCheckNames },
    { env, ghCommand },
  );
  return settledResult({ ...finalState, headSha: baselineSha, attempts: attemptBudget }, {
    settled: false,
    status: options.timeoutMs === 0 ? "pending" : "timeout",
  });
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
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
  stdout.write(`${JSON.stringify(result)}\n`);
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
