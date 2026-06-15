#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parsePrNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION } from "@dev-loops/core/loop/public-dev-loop-routing";
import { watchCopilotReview } from "../github/probe-copilot-review.mjs";
import { runHandoff } from "./copilot-pr-handoff.mjs";
import { detectCopilotSessionActivity } from "./detect-copilot-session-activity.mjs";
import {
  EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
  enforceExternalHealthyWaitTimeout,
} from "@dev-loops/core/loop/timeout-policy";
const REMOVED_FLAGS = new Set([
  "--force-rerequest-review",
  "--probe-only",
]);
const USAGE = `Usage: run-watch-cycle.mjs --repo <owner/name> --pr <number>
Run one deterministic Copilot wait-cycle boundary.
Required:
  --repo <owner/name>       Repository slug (e.g. owner/repo)
  --pr <number>             Pull request number
Output (stdout, JSON):
  { "ok": true, "handoffAction": "watch"|"fix"|"stop", "state": "...",
    "allowedTransitions": [...], "nextAction": "...", "snapshot": {...},
    "requestWatchContract"?: { ... },
    "reviewRequestStatus"?: "...", "watchArgs"?: { ... },
    "watchTimeoutPolicy"?: { "classification": "...", "minimumTimeoutMs": N, "defaultTimeoutMs": N },
    "contractTrace"?: { ... },
    "sessionActivity"?: { ... },
    "watchStatus"?: "changed"|"timeout"|"idle", "watch"?: { ... },
    "loopDisposition": "pending"|"unresolved_feedback"|"clean_converged"|"blocked"|"action_required"|"done",
    "cycleDisposition": "pending"|"needs_followup"|"terminal",
    "roundCapCleanEligible": true|false,
    "terminal": true|false }
Cycle disposition:
  pending         Watch state persists; keep waiting or re-enter later
  needs_followup  Fresh review activity or fix-state follow-up needs action
  terminal        No automatic next step remains
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  runtime failures:
    { "ok": false, "error": "..." }
Exit codes:
  0  Success
  1  Argument error or runtime failure`.trim();
const parseError = buildParseError(USAGE);
function rejectRemovedFlag(token) {
  throw parseError(
    `${token} has been removed. Copilot re-requests and probe-only mode are managed internally. Omit the flag.`,
  );
}
async function fetchPrHeadBranch({ repo, pr }, { env, ghCommand }) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "headRefName"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid JSON from gh: ${result.stdout.trim() || "<empty>"}`);
  }
  if (typeof payload.headRefName !== "string" || payload.headRefName.trim().length === 0) {
    throw new Error("Missing required PR facts: headRefName");
  }
  return payload.headRefName.trim();
}
async function watchWorkflowRun({ repo, runId, timeoutMs = null }, { env, ghCommand }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ghCommand,
      ["run", "watch", String(runId), "--repo", repo],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let timedOut = false;
    let timeoutId = null;
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    if (Number.isInteger(timeoutMs) && timeoutMs >= 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      if (timedOut) {
        resolve({ status: "timed_out" });
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || `exit code ${code}`;
        reject(new Error(`gh command failed: ${detail}`));
        return;
      }
      resolve({ status: "completed" });
    });
  });
}
function determineWatchTimeout(defaultTimeoutMs) {
  return enforceExternalHealthyWaitTimeout({
    timeoutMs: defaultTimeoutMs,
    contextLabel: "Copilot review wait",
  });
}
function buildWatchCycleContractTrace({
  handoff,
  watchArgs = null,
  watchTimeoutPolicy = null,
  watchStatus,
  cycleDisposition,
  sessionActivity = null,
  workflowRunWatch = null,
}) {
  const boundaryClassification = handoff.action !== "watch"
    ? (handoff.loopDisposition === "blocked"
      ? DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.BLOCKED
      : handoff.terminal
        ? DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.TERMINAL
        : DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.ROUTED_FOLLOWUP)
    : watchStatus === "changed"
      ? DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.ROUTED_FOLLOWUP
      : DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.HEALTHY_WAIT;
  return {
    handoff: {
      action: handoff.action,
      state: handoff.state,
      loopDisposition: handoff.loopDisposition,
      terminal: Boolean(handoff.terminal),
    },
    waitStrategy: {
      helper: handoff.action === "watch" ? "scripts/github/probe-copilot-review.mjs" : null,
      mode: handoff.action === "watch"
        ? "persistent_watch"
        : "not_applicable",
      effectiveTimeoutMs: watchArgs?.timeoutMs ?? null,
      effectivePollIntervalMs: watchArgs?.pollIntervalMs ?? null,
      timeoutPolicyClassification: watchTimeoutPolicy?.classification ?? null,
    },
    orchestration: {
      emittedWatchArgs: handoff.watchArgs ?? null,
      effectiveWatchArgs: watchArgs,
      sessionActivity,
      workflowRunWatch,
    },
    stateRefresh: handoff.action === "watch"
      ? {
          boundaryKind: "post_watch_or_probe",
          observedStatus: watchStatus,
          refreshRequired: true,
          refreshReason: watchStatus === "changed"
            ? "Watch boundaries with fresh activity require an authoritative state refresh before routing the follow-up path."
            : "Healthy watch boundaries are observational only; refresh authoritative state before treating timeout/idle as stop or completion.",
        }
      : null,
    stopReason: {
      classification: boundaryClassification,
      terminal: Boolean(handoff.terminal),
      cycleDisposition,
      reason: handoff.action === "watch"
        ? (watchStatus === "changed"
          ? "Fresh watcher activity requires follow-up instead of staying in a healthy wait boundary."
          : "Quiet watcher boundaries remain healthy waits and must not be treated as terminal completion by themselves.")
        : handoff.nextAction,
    },
  };
}
export function parseWatchCycleCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (REMOVED_FLAGS.has(token)) {
      rejectRemovedFlag(token);
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo", parseError).trim();
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePrNumber(requireOptionValue(args, "--pr", parseError), parseError);
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("run-watch-cycle requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
export async function runWatchCycle(
  options,
  {
    env = process.env,
    ghCommand = "gh",
    runHandoffImpl = runHandoff,
    watchCopilotReviewImpl = watchCopilotReview,
    detectCopilotSessionActivityImpl = detectCopilotSessionActivity,
    fetchPrHeadBranchImpl = fetchPrHeadBranch,
    watchWorkflowRunImpl = watchWorkflowRun,
    detectSessionActivity = false,
  } = {},
) {
  const handoff = await runHandoffImpl(options, { env, ghCommand });
  const result = {
    ok: true,
    handoffAction: handoff.action,
    state: handoff.state,
    allowedTransitions: handoff.allowedTransitions,
    nextAction: handoff.nextAction,
    snapshot: handoff.snapshot,
    roundCapCleanEligible: handoff.roundCapCleanEligible ?? false,
    loopDisposition: handoff.loopDisposition,
    cycleDisposition: handoff.action === "stop" ? "terminal" : "needs_followup",
    terminal: Boolean(handoff.terminal),
  };
  if (handoff.requestWatchContract !== undefined) {
    result.requestWatchContract = handoff.requestWatchContract;
  }
  if (handoff.reviewRequestStatus !== undefined) {
    result.reviewRequestStatus = handoff.reviewRequestStatus;
  }
  if (handoff.watchArgs !== undefined) {
    result.watchArgs = handoff.watchArgs;
  }
  if (handoff.watchTimeoutPolicy !== undefined) {
    result.watchTimeoutPolicy = handoff.watchTimeoutPolicy;
  }
  if (handoff.action !== "watch") {
    result.contractTrace = buildWatchCycleContractTrace({
      handoff,
      watchArgs: result.watchArgs ?? null,
      watchTimeoutPolicy: result.watchTimeoutPolicy ?? null,
      watchStatus: result.watchStatus,
      cycleDisposition: result.cycleDisposition,
    });
    return result;
  }
  if (result.watchTimeoutPolicy === undefined) {
    result.watchTimeoutPolicy = EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY;
  }
  const persistentWatchTimeoutMs = determineWatchTimeout(
    handoff.watchArgs.timeoutMs,
  );
  let workflowRunWatch = null;
  if (detectSessionActivity) {
    const headBranch = await fetchPrHeadBranchImpl({ repo: options.repo, pr: options.pr }, { env, ghCommand });
    const session = await detectCopilotSessionActivityImpl(
      {
        repo: options.repo,
        branch: headBranch,
      },
      { env, ghCommand },
    );
    result.sessionActivity = session;
    if (
      session.activity === "active"
      && Number.isInteger(session.runId)
    ) {
      const workflowWatchResult = await watchWorkflowRunImpl(
        {
          repo: options.repo,
          runId: session.runId,
          timeoutMs: persistentWatchTimeoutMs,
        },
        { env, ghCommand },
      );
      workflowRunWatch = {
        attempted: true,
        timeoutMs: persistentWatchTimeoutMs,
        runId: session.runId,
        status: workflowWatchResult?.status ?? "unknown",
      };
    }
  }
  const watchOptions = {
    ...handoff.watchArgs,
    timeoutMs: persistentWatchTimeoutMs,
  };
  const watch = await watchCopilotReviewImpl(watchOptions, { env, ghCommand });
  result.watchArgs = watchOptions;
  result.watchStatus = watch.status;
  result.watch = watch;
  result.cycleDisposition = watch.status === "changed" ? "needs_followup" : "pending";
  result.terminal = false;
  result.contractTrace = buildWatchCycleContractTrace({
    handoff,
    watchArgs: watchOptions,
    watchTimeoutPolicy: result.watchTimeoutPolicy,
    watchStatus: watch.status,
    cycleDisposition: result.cycleDisposition,
    sessionActivity: result.sessionActivity ?? null,
    workflowRunWatch: detectSessionActivity
      ? (workflowRunWatch ?? {
          attempted: false,
          timeoutMs: persistentWatchTimeoutMs,
          runId: result.sessionActivity?.runId ?? null,
          status: null,
        })
      : null,
  });
  return result;
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    env = process.env,
    ghCommand = "gh",
    runHandoffImpl = runHandoff,
    watchCopilotReviewImpl = watchCopilotReview,
  } = {},
) {
  const options = parseWatchCycleCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await runWatchCycle(options, {
    env,
    ghCommand,
    runHandoffImpl,
    watchCopilotReviewImpl,
    detectSessionActivity: true,
  });
  stdout.write(`${JSON.stringify(result)}\n`);
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
