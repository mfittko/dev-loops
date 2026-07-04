#!/usr/bin/env node
import { buildParseError, formatCliError, isCopilotLogin, isDirectCliRun, normalizeTimestamp, parseJsonText } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { detectPostConvergenceSignificantChange } from "./_post-convergence-change.mjs";
import { detectRepoSlug, parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { resolveRunId } from "@dev-loops/core/loop/run-context";
import { loadDevLoopConfig, resolveRefinement } from "@dev-loops/core/config";
import { autoDetectSnapshot } from "./detect-copilot-loop-state.mjs";
import { performCopilotReviewRequest } from "../github/request-copilot-review.mjs";
import { detectInternalOnly as detectPrInternalOnly } from "./detect-internal-only-pr.mjs";
import { applyConfirmedReviewRequest, interpretLoopState, NEXT_ACTIONS, STATE, summarizeLoopInterpretation, TRANSITIONS } from "@dev-loops/core/loop/copilot-loop-state";
import { ensureAsyncRunnerOwnership, releaseAsyncRunnerOwnership } from "./_pr-runner-coordination.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";


import {
  EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
  enforceExternalHealthyWaitTimeout,
} from "@dev-loops/core/loop/timeout-policy";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import {
  DEFAULT_POLL_INTERVAL_MS,
  COPILOT_REVIEW_WAIT_TIMEOUT_MS,
} from "@dev-loops/core/loop/policy-constants";
const VALID_WATCH_STATUSES = new Set(["changed", "timeout", "idle"]);
const REMOVED_FLAGS = new Set([
  "--force-rerequest-review",
]);
const USAGE = `Usage: copilot-pr-handoff.mjs --pr <number> [--repo <owner/name>] [--watch-status <changed|timeout|idle>]
Detect the Copilot-loop state for a PR, request Copilot review only when
a new request is still needed, and emit the recommended next action with
exact parameters.
Required:
  --pr <number>         Pull request number
Optional:
  --repo <owner/name>   Repository slug (e.g. owner/repo). Auto-detected from git remote when omitted.
  --watch-status <status>   Refresh deterministic loop state after a prior
                           watcher result (changed|timeout|idle). This mode
                           never requests review; it only re-detects state.
Output (stdout, JSON):
  { "ok": true, "action": "watch"|"fix"|"stop", "state": "...",
    "allowedTransitions": [...], "nextAction": "...", "snapshot": {...},
    "reviewRequestStatus"?: "...", "watchStatus"?: "...",
    "autoRerequestEligible": true|false, "sameHeadCleanConverged": true|false,
    "roundCapCleanEligible": true|false, "loopDisposition": "...", "terminal": true|false,
    "requestWatchContract": {
      "action": "watch"|"fix"|"stop",
      "nextAction": "...",
      "requestStatus": "requested"|"already-requested"|"unavailable"|"failed"|"none",
      "routingState": "copilot_request_confirmed_waiting"|"ready_state_needs_copilot_request"|"draft_reset_requires_ready_state_reentry"|"non_ready_state",
      "watchEntryConfirmed": true|false,
      "watchArgs": { ... }|null,
      "stopState"?: "unavailable"|"blocked"|"draft_requires_ready_state_reentry"|"no_automatic_next_step"
    },
    "watchTimeoutPolicy"?: { "classification": "...", "minimumTimeoutMs": N, "defaultTimeoutMs": N },
    "watchArgs"?: { "repo": "...", "pr": N, "pollIntervalMs": N, "timeoutMs": N } }
Actions:
  watch   Copilot review was requested; use watchArgs with probe-copilot-review.mjs
  fix     Unresolved feedback exists; address it before re-requesting review
  stop    No automatic next step; report the current state (terminal, blocked, or operator-decision-required) and do not proceed
Watch refresh rule:
  watcher timeout/idle is observational only. Re-run this helper with
  --watch-status and stop only when terminal=true. Pending or unresolved
  states remain non-terminal even after a timeout.
Watch defaults:
  pollIntervalMs  60000  (1 minute)
  timeoutMs       1800000   (30 minutes)
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const WATCH_STATES = new Set([
  STATE.WAITING_FOR_COPILOT_REVIEW,
]);
const FIX_STATES = new Set([
  STATE.UNRESOLVED_FEEDBACK_PRESENT,
  STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE,
  STATE.INTERNAL_TOOLING_DIRECT_GATE,
]);
function summarizeRequestWatchContract({
  interpretation,
  action,
  requestStatus,
  watchArgs,
}) {
  let routingState = "non_ready_state";
  if (action === "watch" && (requestStatus === "requested" || requestStatus === "already-requested")) {
    routingState = "copilot_request_confirmed_waiting";
  } else if (interpretation.state === STATE.PR_DRAFT) {
    routingState = "draft_reset_requires_ready_state_reentry";
  } else if (
    interpretation.state === STATE.PR_READY_NO_FEEDBACK
    || interpretation.state === STATE.READY_TO_REREQUEST_REVIEW
    && interpretation.sameHeadCleanConverged !== true
  ) {
    routingState = "ready_state_needs_copilot_request";
  } else if (interpretation.state === STATE.INTERNAL_TOOLING_DIRECT_GATE) {
    routingState = "internal_tooling_skip_copilot";
  }
  let stopState;
  if (action === "stop") {
    if (interpretation.state === STATE.REVIEW_REQUEST_UNAVAILABLE) {
      stopState = "unavailable";
    } else if (interpretation.state === STATE.BLOCKED_NEEDS_USER_DECISION) {
      stopState = "blocked";
    } else if (interpretation.state === STATE.PR_DRAFT) {
      stopState = "draft_requires_ready_state_reentry";
    } else {
      stopState = "no_automatic_next_step";
    }
  }
  return {
    action,
    nextAction: interpretation.nextAction,
    requestStatus,
    routingState,
    watchEntryConfirmed: action === "watch" && watchArgs !== undefined,
    watchArgs: watchArgs ?? null,
    stopState,
  };
}
const parseError = buildParseError(USAGE);
function rejectRemovedFlag(token) {
  throw parseError(
    `${token} has been removed. Copilot re-requests are managed internally. Omit the flag.`,
  );
}
export function parseHandoffCliArgs(argv, { cwd = process.cwd() } = {}) {
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    watchStatus: undefined,
    jq: undefined,
    silent: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "watch-status": { type: "string" },
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
    if (token.name === "watch-status") {
      const watchStatus = requireTokenValue(token, parseError).trim().toLowerCase();
      if (!VALID_WATCH_STATUSES.has(watchStatus)) {
        throw parseError(`--watch-status must be one of: ${[...VALID_WATCH_STATUSES].join(", ")}`);
      }
      options.watchStatus = watchStatus;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.pr === undefined) {
    throw parseError("copilot-pr-handoff requires --pr <number>");
  }
  if (options.repo === undefined) {
    options.repo = detectRepoSlug(cwd);
    if (!options.repo) {
      throw parseError(
        "Repo auto-detection failed. " +
        "Run from a git repo checkout or provide --repo <owner/name>."
      );
    }
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
/**
 * Detect recent human (non-bot) comments on a PR since the last subagent action.
 * Determines "last subagent action" by finding the most recent bot/Copilot comment
 * on the PR issue comments. If a human comment exists after that timestamp, the
 * loop should pause for operator review.
 * Returns { paused: true, humanComments: [...] } when human comments need attention.
 */
export async function detectRecentHumanComments({ repo, pr, claimedAtMs }, { env = process.env, ghCommand = "gh" } = {}) {
  try {
    const result = await runChild(
      ghCommand,
      ["api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--jq", ".[]"],
      env,
    );
    if (result.code !== 0) {
      return { paused: false, error: "comment_fetch_failed", detail: "Failed to fetch PR comments; human comment detection unavailable." };
    }
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      return { paused: false };
    }
    let comments;
    try {
      comments = lines.map((line) => JSON.parse(line));
    } catch {
      return { paused: false, error: "comment_parse_failed", detail: "Failed to parse PR comments JSON; human comment detection unavailable." };
    }
    if (!Array.isArray(comments)) {
      return { paused: false };
    }

    // Find the most recent bot/Copilot comment timestamp (last subagent action)
    let lastBotActionMs = null;
    for (const comment of comments) {
      const authorLogin = comment?.user?.login ?? "";
      if (!isCopilotLogin(authorLogin)) {
        continue;
      }
      const createdAt = normalizeTimestamp(comment?.created_at);
      if (createdAt !== null && (lastBotActionMs === null || createdAt > lastBotActionMs)) {
        lastBotActionMs = createdAt;
      }
    }

    // If no Copilot comments found, use the run's claim time as baseline when available
    if (lastBotActionMs === null) {
      if (typeof claimedAtMs === "number" && claimedAtMs > 0) {
        lastBotActionMs = claimedAtMs;
      } else {
        return { paused: false };
      }
    }

    // Find human comments after the last bot action
    const humanComments = [];
    for (const comment of comments) {
      const authorLogin = comment?.user?.login ?? "";
      const authorType = comment?.user?.type ?? "";
      // Skip bot authors (GitHub type "Bot") and Copilot
      if (authorType === "Bot" || isCopilotLogin(authorLogin)) {
        continue;
      }
      // Skip if comment body is a gate verdict comment (system action, not operator input)
      const body = typeof comment?.body === "string" ? comment.body : "";
      if (body.includes("Gate review:") || body.includes("**draft_gate**") || body.includes("**pre_approval_gate**")) {
        continue;
      }
      const createdAt = normalizeTimestamp(comment?.created_at);
      if (createdAt !== null && createdAt > lastBotActionMs) {
        humanComments.push({
          id: comment.id,
          author: authorLogin,
          createdAt: comment.created_at,
          bodyPreview: body.slice(0, 200),
        });
      }
    }

    return {
      paused: humanComments.length > 0,
      humanComments: humanComments.length > 0 ? humanComments : undefined,
      lastBotCommentAt: lastBotActionMs !== null ? new Date(lastBotActionMs).toISOString() : undefined,
    };
  } catch {
    return { paused: false, error: "unexpected_error", detail: "Unexpected error during human comment detection." };
  }
}

// Facts needed by the round-cap escape-hatch significant-change detector
// (#1103, #1126): the current head, the Copilot reviews (to find the last
// reviewed head), and the PR's changed files. Fetched only when the interpreter
// already resolved ROUND_CAP_CLEAN_FALLBACK, so this extra call is off the hot path.
async function fetchReopenCycleFacts({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,reviews,files"],
    env,
  );
  if (result.code !== 0) {
    return null;
  }
  try {
    return parseJsonText(result.stdout, { label: "gh pr view reopen-cycle facts" });
  } catch {
    return null;
  }
}

export async function runHandoff(options, { env = process.env, ghCommand = "gh" } = {}) {
  const runnerOwnership = await ensureAsyncRunnerOwnership({
    repo: options.repo,
    pr: options.pr,
    env,
    cwd: resolveRepoRoot(process.cwd()),
    claimIfMissing: true,
  });
  if (!runnerOwnership.ok) {
    return {
      ok: true,
      action: "stop",
      state: STATE.BLOCKED_NEEDS_USER_DECISION,
      allowedTransitions: [],
      nextAction: runnerOwnership.message,
      autoRerequestEligible: false,
      sameHeadCleanConverged: false,
      roundCapCleanEligible: false,
      loopDisposition: "blocked",
      terminal: true,
      snapshot: { repo: options.repo, pr: options.pr },
      runnerOwnership,
      requestWatchContract: {
        action: "stop",
        nextAction: runnerOwnership.message,
        requestStatus: "none",
        routingState: "non_ready_state",
        watchEntryConfirmed: false,
        watchArgs: null,
        stopState: "blocked",
      },
    };
  }
  let snapshot = await autoDetectSnapshot(
    { repo: options.repo, pr: options.pr },
    { env, ghCommand },
  );
  const config = await loadDevLoopConfig({ repoRoot: resolveRepoRoot(process.cwd()) });
  if (config.errors?.length > 0) {
    console.error("[copilot-pr-handoff] config warnings:", JSON.stringify(config.errors));
  }
  const refinementConfig = config.errors?.length > 0
    ? resolveRefinement({ version: 1 })
    : resolveRefinement(config.config);
  let interpretation = interpretLoopState(snapshot, refinementConfig);

  // Check for human comments since last subagent action
  // Only active in async subagent context (DEVLOOPS_RUN_ID set)
  let humanCommentCheck = { paused: false };
  if (resolveRunId(env)) {
    humanCommentCheck = await detectRecentHumanComments(
      { repo: options.repo, pr: options.pr, claimedAtMs: runnerOwnership?.activeRun?.claimedAt ? new Date(runnerOwnership.activeRun.claimedAt).getTime() : undefined },
      { env, ghCommand },
    );
  }
  const TERMINAL_STATES = new Set([STATE.NO_PR, STATE.DONE, STATE.BLOCKED_NEEDS_USER_DECISION]);
  const humanCommentUnavailable = humanCommentCheck.error && !humanCommentCheck.paused;
  if ((humanCommentCheck.paused || humanCommentUnavailable) && !TERMINAL_STATES.has(interpretation.state)) {
    const runnerRelease = await releaseAsyncRunnerOwnership({
      repo: options.repo,
      pr: options.pr,
      env,
      cwd: resolveRepoRoot(process.cwd()),
    });
    return {
      ok: true,
      action: "stop",
      state: STATE.BLOCKED_NEEDS_USER_DECISION,
      allowedTransitions: [],
      nextAction: humanCommentCheck.paused
        ? "Human comment detected on PR since last subagent action; review the comment(s) before continuing the automated loop."
        : `Human comment detection unavailable (${humanCommentCheck.error}); review PR comments manually before continuing.`,
      autoRerequestEligible: false,
      sameHeadCleanConverged: false,
      roundCapCleanEligible: false,
      loopDisposition: "blocked",
      terminal: true,
      snapshot,
      runnerOwnership,
      ...(runnerRelease.status !== "skipped_no_async_run_id" ? { runnerRelease } : {}),
      humanCommentPause: {
        reason: humanCommentCheck.paused ? "human_comment_detected" : "human_comment_check_unavailable",
        error: humanCommentCheck.error || undefined,
        humanComments: humanCommentCheck.humanComments,
        lastBotCommentAt: humanCommentCheck.lastBotCommentAt,
      },
      requestWatchContract: {
        action: "stop",
        nextAction: humanCommentCheck.paused
        ? "Human comment detected on PR since last subagent action; review the comment(s) before continuing the automated loop."
        : `Human comment detection unavailable (${humanCommentCheck.error}); review PR comments manually before continuing.`,
        requestStatus: "none",
        routingState: "non_ready_state",
        watchEntryConfirmed: false,
        watchArgs: null,
        stopState: "blocked",
      },
    };
  }


  // Detect internal tooling PRs — suppress Copilot review request step entirely.
  // Internal-only PRs (scripts/docs/tests/config) skip the request, not just the wait.
  let internalOnlySkipCopilot = false;
  // Config opt-out (#832): maxCopilotRounds: 0 disables the external Copilot review
  // gate for the repo (local-harness-only review). Treat it like an internal-only PR
  // — skip the request, not just the wait — regardless of stub/sequence mode. This
  // mirrors the gate-coordination side, which routes maxCopilotRounds: 0 to internal_only.
  if (refinementConfig?.maxCopilotRounds === 0 &&
      options.watchStatus === undefined &&
      (interpretation.state === STATE.PR_READY_NO_FEEDBACK ||
       interpretation.state === STATE.READY_TO_REREQUEST_REVIEW)) {
    internalOnlySkipCopilot = true;
    interpretation = {
      ...interpretation,
      state: STATE.INTERNAL_TOOLING_DIRECT_GATE,
      nextAction: NEXT_ACTIONS[STATE.INTERNAL_TOOLING_DIRECT_GATE],
      allowedTransitions: TRANSITIONS[STATE.INTERNAL_TOOLING_DIRECT_GATE] || [STATE.DONE],
    };
  }
  // Skip internal detection in sequential stub/test mode to avoid consuming stub entries.
  // Claims-mode stubs handle interleaved calls; detection runs normally.
  if (
    !internalOnlySkipCopilot &&
    (!env.GH_SEQUENCE_PATH || env.GH_STUB_MODE === "claims") &&
    options.watchStatus === undefined &&
    (interpretation.state === STATE.PR_READY_NO_FEEDBACK ||
      interpretation.state === STATE.READY_TO_REREQUEST_REVIEW)
  ) {
    try {
      const internalCheck = await detectPrInternalOnly(options, { env, ghCommand });
      if (internalCheck.ok && internalCheck.internalOnly) {
        internalOnlySkipCopilot = true;
        interpretation = {
          ...interpretation,
          state: STATE.INTERNAL_TOOLING_DIRECT_GATE,
          nextAction: NEXT_ACTIONS[STATE.INTERNAL_TOOLING_DIRECT_GATE],
          allowedTransitions: TRANSITIONS[STATE.INTERNAL_TOOLING_DIRECT_GATE] || [STATE.DONE],
        };
      }
    } catch {
      // Best-effort: if detection fails, fall through to normal request behavior
    }
  }

  // Round-cap escape hatch (#1103, #1126): the interpreter resolves
  // ROUND_CAP_CLEAN_FALLBACK (stop, no re-request) at the cap. But when a
  // SIGNIFICANT post-convergence change (new product/test-logic since the last
  // Copilot review — not doc/comment-only) has landed, a new Copilot cycle is
  // owed. Reopen it here via the SAME shared detector detect-pr-gate-coordination-state
  // uses, so the two agree: both offer a re-request iff (cap reached AND
  // significant post-convergence change). A doc-only change stays at the clean
  // fallback (stop), unchanged.
  let reopenedCapCycle = false;
  if (!internalOnlySkipCopilot
      && options.watchStatus === undefined
      && interpretation.state === STATE.ROUND_CAP_CLEAN_FALLBACK) {
    const reopenFacts = await fetchReopenCycleFacts(options, { env, ghCommand });
    const significant = await detectPostConvergenceSignificantChange(
      {
        repo: options.repo,
        pr: options.pr,
        currentHeadSha: typeof reopenFacts?.headRefOid === "string" ? reopenFacts.headRefOid.trim() : null,
        reviews: reopenFacts?.reviews,
        changedFiles: reopenFacts?.files,
        roundCapReached: true,
        regularCopilotRounds: (snapshot.copilotReviewRoundCount ?? 0) > 0,
      },
      { env, ghCommand },
    );
    if (significant) {
      reopenedCapCycle = true;
      interpretation = {
        ...interpretation,
        state: STATE.READY_TO_REREQUEST_REVIEW,
        nextAction: NEXT_ACTIONS[STATE.READY_TO_REREQUEST_REVIEW],
        allowedTransitions: [...(TRANSITIONS[STATE.READY_TO_REREQUEST_REVIEW] || [])],
        autoRerequestEligible: true,
        roundCapCleanEligible: false,
      };
    }
  }

  let reviewRequestStatus;
  const shouldRequestReview = !internalOnlySkipCopilot && options.watchStatus === undefined
    && (interpretation.state === STATE.PR_READY_NO_FEEDBACK
    || interpretation.state === STATE.READY_TO_REREQUEST_REVIEW
    && interpretation.autoRerequestEligible);
  if (shouldRequestReview) {
    const requestResult = await performCopilotReviewRequest(
      {
        repo: options.repo,
        pr: options.pr,
        sameHeadCleanConverged: interpretation.sameHeadCleanConverged,
        // A reopened cap cycle was decided via the shared significant-change
        // detector; tell the requester to honor it. performCopilotReviewRequest
        // still refuses unless the head actually advanced past the last review
        // (its hasNewCommits guard), so this cannot force an over-cap same-head request.
        forceRerequestReview: reopenedCapCycle,
      },
      { env, ghCommand },
    );
    reviewRequestStatus = requestResult.status;
    snapshot = applyConfirmedReviewRequest(snapshot, reviewRequestStatus);
    interpretation = interpretLoopState(snapshot, refinementConfig);
    // The re-interpretation re-hits the round cap (rounds still >= max) and would
    // flip a reopened cycle back to ROUND_CAP_CLEAN_FALLBACK. A confirmed request
    // for a significant new change is a genuine new wait cycle, so map it to the
    // honest WAITING_FOR_COPILOT_REVIEW state (what a below-cap re-request yields).
    if (reopenedCapCycle
        && (reviewRequestStatus === "requested" || reviewRequestStatus === "already-requested")) {
      interpretation = {
        ...interpretation,
        state: STATE.WAITING_FOR_COPILOT_REVIEW,
        nextAction: NEXT_ACTIONS[STATE.WAITING_FOR_COPILOT_REVIEW],
        allowedTransitions: [...(TRANSITIONS[STATE.WAITING_FOR_COPILOT_REVIEW] || [])],
        roundCapCleanEligible: false,
      };
    }
  }
  const interpretationSummary = summarizeLoopInterpretation(interpretation, refinementConfig);
  const effectiveReviewRequestStatus = reviewRequestStatus
    ?? (snapshot.copilotReviewRequestStatus === "requested" || snapshot.copilotReviewRequestStatus === "already-requested"
      ? snapshot.copilotReviewRequestStatus
      : undefined);
  let action;
  if (reviewRequestStatus === "requested" || reviewRequestStatus === "already-requested") {
    action = "watch";
  } else if (WATCH_STATES.has(interpretation.state)) {
    action = "watch";
  } else if (FIX_STATES.has(interpretation.state)) {
    action = "fix";
  } else {
    action = "stop";
  }
  const result = {
    ok: true,
    action,
    state: interpretation.state,
    allowedTransitions: interpretation.allowedTransitions,
    nextAction: interpretation.nextAction,
    autoRerequestEligible: interpretation.autoRerequestEligible,
    sameHeadCleanConverged: interpretation.sameHeadCleanConverged,
    roundCapCleanEligible: interpretation.roundCapCleanEligible ?? false,
    loopDisposition: interpretationSummary.loopDisposition,
    terminal: interpretationSummary.terminal,
    snapshot,
    internalOnlySkipCopilot: internalOnlySkipCopilot || undefined,
  };
  if (runnerOwnership.status !== "skipped_no_async_run_id") {
    result.runnerOwnership = runnerOwnership;
  }
  if (effectiveReviewRequestStatus !== undefined) {
    result.reviewRequestStatus = effectiveReviewRequestStatus;
  }
  if (options.watchStatus !== undefined) {
    result.watchStatus = options.watchStatus;
  }
  if (action === "watch") {
    result.watchTimeoutPolicy = EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY;
    result.watchArgs = {
      repo: options.repo,
      pr: options.pr,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      timeoutMs: enforceExternalHealthyWaitTimeout({
        timeoutMs: COPILOT_REVIEW_WAIT_TIMEOUT_MS,
        contextLabel: "Copilot review wait",
      }),
    };
  }
  const normalizedRequestStatus = effectiveReviewRequestStatus
    ?? (snapshot.copilotReviewRequestStatus === "unavailable"
      || snapshot.copilotReviewRequestStatus === "failed"
      ? snapshot.copilotReviewRequestStatus
      : "none");
  result.requestWatchContract = summarizeRequestWatchContract({
    interpretation,
    action,
    requestStatus: normalizedRequestStatus,
    watchArgs: result.watchArgs,
  });
  if (result.terminal === true) {
    const runnerRelease = await releaseAsyncRunnerOwnership({
      repo: options.repo,
      pr: options.pr,
      env,
      cwd: resolveRepoRoot(process.cwd()),
    });
    if (runnerRelease.status !== "skipped_no_async_run_id") {
      result.runnerRelease = runnerRelease;
    }
  }
  return result;
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const options = parseHandoffCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await runHandoff(options, { env, ghCommand });
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
