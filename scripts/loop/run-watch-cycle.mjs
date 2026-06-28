#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION } from "@dev-loops/core/loop/public-dev-loop-routing";
import { watchCopilotReview } from "../github/probe-copilot-review.mjs";
import { watchCiStatus } from "../github/probe-ci-status.mjs";
import { runHandoff } from "./copilot-pr-handoff.mjs";
import { STATE } from "@dev-loops/core/loop/copilot-loop-state";
import { DEFAULT_POLL_INTERVAL_MS } from "@dev-loops/core/loop/policy-constants";
import { detectCopilotSessionActivity } from "./detect-copilot-session-activity.mjs";
import { parseArgs } from "node:util";
import {
  EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
  enforceExternalHealthyWaitTimeout,
} from "@dev-loops/core/loop/timeout-policy";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
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
Concise mode:
  --concise, --summary      Human-readable summary: loop state, copilot rounds,
                            unresolved/actionable thread counts, round-cap-clean
                            eligibility, CI status, next action, AND the current
                            round's new Copilot comment bodies.
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or runtime failure
  2  Invalid --jq filter`.trim();
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
  ciWatchArgs = null,
  ciWatchStatus = null,
}) {
  // The CI-watch branch (waiting_for_ci) routes through probe-ci-status.mjs even
  // though handoff.action !== "watch". It is an observational wait, so it mirrors
  // the Copilot watch classification: a quiet timeout is a HEALTHY_WAIT, while
  // success/failure/changed route a follow-up. Without this the boundary-action
  // path below would misclassify a CI timeout as routed_followup.
  const isCiWatch = ciWatchArgs !== null;
  const isWatchBoundary = handoff.action === "watch" || isCiWatch;
  const observedStatus = isCiWatch ? ciWatchStatus : watchStatus;
  const boundaryClassification = isWatchBoundary
    ? (observedStatus === "timeout" || observedStatus === "idle"
      ? DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.HEALTHY_WAIT
      : DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.ROUTED_FOLLOWUP)
    : handoff.loopDisposition === "blocked"
      ? DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.BLOCKED
      : handoff.terminal
        ? DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.TERMINAL
        : DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.ROUTED_FOLLOWUP;
  const healthyWait = boundaryClassification === DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.HEALTHY_WAIT;
  const helper = handoff.action === "watch"
    ? "scripts/github/probe-copilot-review.mjs"
    : isCiWatch
      ? "scripts/github/probe-ci-status.mjs"
      : null;
  const effectiveArgs = isCiWatch ? ciWatchArgs : watchArgs;
  return {
    handoff: {
      action: handoff.action,
      state: handoff.state,
      loopDisposition: handoff.loopDisposition,
      terminal: Boolean(handoff.terminal),
    },
    waitStrategy: {
      helper,
      mode: isWatchBoundary ? "persistent_watch" : "not_applicable",
      effectiveTimeoutMs: effectiveArgs?.timeoutMs ?? null,
      effectivePollIntervalMs: effectiveArgs?.pollIntervalMs ?? null,
      timeoutPolicyClassification: watchTimeoutPolicy?.classification ?? null,
    },
    orchestration: {
      emittedWatchArgs: handoff.watchArgs ?? null,
      effectiveWatchArgs: effectiveArgs,
      ciWatchArgs,
      sessionActivity,
      workflowRunWatch,
    },
    stateRefresh: isWatchBoundary
      ? {
          boundaryKind: "post_watch_or_probe",
          observedStatus,
          refreshRequired: true,
          refreshReason: healthyWait
            ? "Healthy watch boundaries are observational only; refresh authoritative state before treating timeout/idle as stop or completion."
            : "Watch boundaries with fresh activity require an authoritative state refresh before routing the follow-up path.",
        }
      : null,
    stopReason: {
      classification: boundaryClassification,
      terminal: Boolean(handoff.terminal),
      cycleDisposition,
      reason: isWatchBoundary
        ? (healthyWait
          ? "Quiet watcher boundaries remain healthy waits and must not be treated as terminal completion by themselves."
          : "Fresh watcher activity requires follow-up instead of staying in a healthy wait boundary.")
        : handoff.nextAction,
    },
  };
}
export function parseWatchCycleCliArgs(argv) {
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    concise: false,
    jq: undefined,
    silent: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      concise: { type: "boolean" },
      summary: { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
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
    if (REMOVED_FLAGS.has(token.rawName)) {
      rejectRemovedFlag(token.rawName);
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "concise" || token.name === "summary") {
      options.concise = true;
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
    watchCiStatusImpl = watchCiStatus,
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
  // Provider-agnostic CI wait (#917): a waiting_for_ci boundary would otherwise
  // dead-end at action:"stop". Route it to the helper-owned CI watcher
  // (CircleCI / GH Actions / external commit-status), not gh run watch.
  if (handoff.action !== "watch" && handoff.state === STATE.WAITING_FOR_CI) {
    // Mirror determineWatchTimeout but with a CI-specific context label so
    // timeout diagnostics read "CI wait" instead of "Copilot review wait".
    const ciTimeoutMs = enforceExternalHealthyWaitTimeout({
      timeoutMs: EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY.defaultTimeoutMs,
      contextLabel: "CI wait",
    });
    const ciWatchArgs = {
      repo: options.repo,
      pr: options.pr,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      timeoutMs: ciTimeoutMs,
    };
    const ciWatch = await watchCiStatusImpl(ciWatchArgs, { env, ghCommand });
    result.ciWatchArgs = ciWatchArgs;
    result.ciWatch = ciWatch;
    result.watchStatus = ciWatch.status;
    // success/failure/changed all need authoritative re-detection (follow-up);
    // a quiet timeout stays a healthy pending wait.
    result.cycleDisposition = ciWatch.status === "timeout" ? "pending" : "needs_followup";
    result.terminal = false;
    result.contractTrace = buildWatchCycleContractTrace({
      handoff,
      watchTimeoutPolicy: result.watchTimeoutPolicy ?? null,
      cycleDisposition: result.cycleDisposition,
      ciWatchArgs,
      ciWatchStatus: ciWatch.status,
    });
    return result;
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
// Human-readable concise summary covering loop state, Copilot round count,
// unresolved/actionable thread counts, round-cap-clean eligibility, CI status,
// next action, AND the current round's new Copilot comment bodies (from the
// embedded watch probe result). This is the field set the loop needs to read
// without parsing the full JSON blob (issue #981).
export function formatWatchCycleConcise(result) {
  const snapshot = result.snapshot ?? {};
  const lines = [
    `Watch cycle: PR #${snapshot.prNumber ?? "?"}`,
    `  loop state:          ${result.state}`,
    `  handoff action:      ${result.handoffAction}`,
    `  copilot rounds:      ${snapshot.copilotReviewRoundCount ?? 0}`,
    `  unresolved threads:  ${snapshot.unresolvedThreadCount ?? 0}`,
    `  actionable threads:  ${snapshot.actionableThreadCount ?? 0}`,
    `  round-cap clean:     ${result.roundCapCleanEligible ? "yes" : "no"}`,
    `  CI status:           ${snapshot.ciStatus ?? "none"}`,
    `  loop disposition:    ${result.loopDisposition}`,
    `  cycle disposition:   ${result.cycleDisposition}`,
    `  watch status:        ${result.watchStatus ?? "(not watched)"}`,
    `  terminal:            ${result.terminal ? "yes" : "no"}`,
    `  next action:         ${result.nextAction}`,
  ];
  const watch = result.watch ?? {};
  const bodies = [
    ...(watch.newReviews ?? []).map((r) => ({ kind: "review", body: r.body })),
    ...(watch.newComments ?? []).map((c) => ({ kind: "threadComment", body: c.body })),
    ...(watch.newIssueComments ?? []).map((c) => ({ kind: "issueComment", body: c.body })),
  ].filter((entry) => typeof entry.body === "string" && entry.body.trim().length > 0);
  if (bodies.length > 0) {
    lines.push("  new Copilot comment bodies this round:");
    for (const entry of bodies) {
      const indented = entry.body.trim().split("\n").map((l) => `      ${l}`).join("\n");
      lines.push(`    [${entry.kind}]`);
      lines.push(indented);
    }
  } else {
    lines.push("  new Copilot comment bodies this round: (none)");
  }
  return lines.join("\n");
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
  if (options.concise && options.jq === undefined && !options.silent) {
    stdout.write(`${formatWatchCycleConcise(result)}\n`);
    return result.ok === false ? 1 : 0;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout });
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
