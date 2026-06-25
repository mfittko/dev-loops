/**
 * Deterministic state machine for the async Copilot review/fix loop.
 *
 * This module provides:
 * - STATE: stable state name constants
 * - TRANSITIONS: legal next-state graph for each state
 * - normalizeSnapshot: validate and canonicalize a raw loop-state snapshot
 * - interpretLoopState: map a snapshot to one current state + allowed transitions + next action
 *
 * The state machine owns workflow control.
 * Agent judgment (accept/defer a comment, confirm a fix, decide on another Copilot pass)
 * becomes an explicit bounded input (agentFixStatus) rather than hidden orchestration behavior.
 */

import { normalizeStatusCheckRollupContract } from "./copilot-ci-status.mjs";

/** Stable state name constants for the async Copilot review/fix loop. */
export const STATE = Object.freeze({
  /** No open PR exists for the current work. */
  NO_PR: "no_pr",
  /** PR exists but is in draft state. */
  PR_DRAFT: "pr_draft",
  /** PR is ready-for-review; no Copilot review has been requested or received yet. */
  PR_READY_NO_FEEDBACK: "pr_ready_no_feedback",
  /** Copilot review was requested and is in requested_reviewers; waiting for review activity. */
  WAITING_FOR_COPILOT_REVIEW: "waiting_for_copilot_review",
  /** Unresolved review threads exist that require a fix and/or reply/resolve action. */
  UNRESOLVED_FEEDBACK_PRESENT: "unresolved_feedback_present",
  /**
   * Agent has applied a fix; unresolved threads still exist on GitHub and need
   * reply/resolve before another Copilot pass or re-request is appropriate.
   */
  ALREADY_FIXED_NEEDS_REPLY_RESOLVE: "already_fixed_needs_reply_resolve",
  /**
   * All threads are resolved; Copilot has reviewed at least once and is not
   * currently requested. Ready to re-request a new Copilot pass or confirm done.
   */
  READY_TO_REREQUEST_REVIEW: "ready_to_rerequest_review",
  /**
   * Low-signal heuristic stopped the re-request loop. Round count exceeded
   * threshold with only minimal actionable feedback per round.
   */
  LOW_SIGNAL_CONVERGED: "low_signal_converged",
  /**
   * Copilot review request returned `unavailable`. Must stop/report.
   * Do not sleep or watch as if review were requested.
   */
  REVIEW_REQUEST_UNAVAILABLE: "review_request_unavailable",
  /** CI checks are in progress or no usable CI readiness signal exists yet; wait before proceeding. */
  WAITING_FOR_CI: "waiting_for_ci",
  /**
   * An unexpected failure occurred (bad review-request result, CI failure, etc.)
   * that requires user decision before the loop can continue.
   */
  BLOCKED_NEEDS_USER_DECISION: "blocked_needs_user_decision",
  /** PR has been merged or closed. Loop is complete. */
  DONE: "done",
  /** Round cap reached with unresolved threads or failing CI; explicit stop. */
  ROUND_CAP_REACHED: "round_cap_reached",
  /** Round cap reached with clean threads and green CI; eligible for pre_approval_gate fallback. */
  ROUND_CAP_CLEAN_FALLBACK: "round_cap_clean_fallback",
  /** Internal tooling only PR; Copilot external review skipped, proceed directly to pre_approval_gate. */
  INTERNAL_TOOLING_DIRECT_GATE: "internal_tooling_direct_gate",
});

/** Stable high-level loop dispositions for completion vs follow-up decisions. */
export const DISPOSITION = Object.freeze({
  PENDING: "pending",
  UNRESOLVED_FEEDBACK: "unresolved_feedback",
  CLEAN_CONVERGED: "clean_converged",
  BLOCKED: "blocked",
  ACTION_REQUIRED: "action_required",
  DONE: "done",
  /** Internal tooling only: Copilot skipped, ready for pre_approval_gate. */
  DIRECT_GATE: "direct_gate",
});

/**
 * Legal transitions for each state.
 * Each entry lists the states that are reachable from the given state.
 * The agent layer selects among allowed transitions; the state machine enforces the graph.
 */
export const TRANSITIONS = Object.freeze({
  [STATE.NO_PR]: [],
  [STATE.PR_DRAFT]: [STATE.PR_READY_NO_FEEDBACK],
  [STATE.PR_READY_NO_FEEDBACK]: [STATE.WAITING_FOR_COPILOT_REVIEW],
  [STATE.WAITING_FOR_COPILOT_REVIEW]: [
    STATE.UNRESOLVED_FEEDBACK_PRESENT,
    STATE.READY_TO_REREQUEST_REVIEW,
    STATE.WAITING_FOR_CI,
  ],
  [STATE.UNRESOLVED_FEEDBACK_PRESENT]: [
    STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE,
    STATE.UNRESOLVED_FEEDBACK_PRESENT,
  ],
  [STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE]: [
    STATE.READY_TO_REREQUEST_REVIEW,
  ],
  [STATE.READY_TO_REREQUEST_REVIEW]: [
    STATE.WAITING_FOR_COPILOT_REVIEW,
    STATE.REVIEW_REQUEST_UNAVAILABLE,
    STATE.DONE,
  ],
  [STATE.REVIEW_REQUEST_UNAVAILABLE]: [],
  [STATE.WAITING_FOR_CI]: [
    STATE.PR_READY_NO_FEEDBACK,
    STATE.READY_TO_REREQUEST_REVIEW,
    STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [STATE.BLOCKED_NEEDS_USER_DECISION]: [],
  [STATE.DONE]: [],
  [STATE.LOW_SIGNAL_CONVERGED]: [],
  [STATE.ROUND_CAP_REACHED]: [],
  [STATE.ROUND_CAP_CLEAN_FALLBACK]: [],
  [STATE.INTERNAL_TOOLING_DIRECT_GATE]: [STATE.DONE],
});

/** Recommended next action for each state. */
export const NEXT_ACTIONS = Object.freeze({
  [STATE.NO_PR]: "Create a PR or hand work to Copilot",
  [STATE.PR_DRAFT]: "Move the PR from draft to ready-for-review",
  [STATE.PR_READY_NO_FEEDBACK]: "Request Copilot review via scripts/github/request-copilot-review.mjs",
  [STATE.WAITING_FOR_COPILOT_REVIEW]: "Wait for Copilot review via scripts/github/probe-copilot-review.mjs",
  [STATE.UNRESOLVED_FEEDBACK_PRESENT]: "Address unresolved review feedback, then reply to and resolve each thread on GitHub",
  [STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE]: "Reply to and resolve addressed threads on GitHub via scripts/github/reply-resolve-review-thread.mjs before re-requesting review",
  [STATE.READY_TO_REREQUEST_REVIEW]: "Re-request Copilot review via scripts/github/request-copilot-review.mjs only after smallest honest local validation is green and no known fixable CI-red state remains, or confirm the PR is done",
  [STATE.REVIEW_REQUEST_UNAVAILABLE]: "Report that Copilot review is unavailable and stop; do not sleep or watch as if review were requested",
  [STATE.WAITING_FOR_CI]: "Wait for CI checks to complete or become available",
  [STATE.BLOCKED_NEEDS_USER_DECISION]: "Report the blocked state to the user and stop; do not proceed without explicit authorization",
  [STATE.LOW_SIGNAL_CONVERGED]: "Low-signal heuristic stopped re-request loop: round count exceeded threshold with only minimal actionable feedback; treat as converged",
  [STATE.ROUND_CAP_REACHED]: "Stop: Copilot review round limit reached with unresolved threads or failing CI; do not re-request review",
  [STATE.ROUND_CAP_CLEAN_FALLBACK]: "Round cap reached with clean PR; continue to pre_approval_gate instead of re-requesting Copilot review",
  [STATE.INTERNAL_TOOLING_DIRECT_GATE]: "Internal tooling PR — Copilot external review suppressed; run pre_approval_gate directly",
  [STATE.DONE]: "Loop is complete; confirm merge-readiness or close",
});

const SAME_HEAD_CLEAN_CONVERGED_NEXT_ACTION = "Current head already has a clean submitted Copilot review; suppress automatic same-head re-request unless a meaningful remediation event occurs, or explicitly request another Copilot pass";

const VALID_REVIEW_REQUEST_STATUSES = new Set(["requested", "already-requested", "unavailable", "none", "failed"]);
const VALID_CI_STATUSES = new Set(["success", "failure", "pending", "none", "crediblyGreen"]);
const ACTIVE_REQUEST_STATUSES = new Set(["requested", "already-requested"]);

function isWaitingCiStatus(status) {
  return status === "pending" || status === "none";
}

function isBlockedCiStatus(status) {
  return status === "failure";
}

export function normalizeCiStatus(rollup) {
  return normalizeStatusCheckRollupContract(rollup).overallStatus;
}

export function buildSnapshotFromPrFacts({
  prData,
  prNumber,
  copilotReviewRequestStatus = "none",
  copilotReviewPresent = false,
  copilotReviewOnCurrentHead = false,
  unresolvedThreadCount = 0,
  actionableThreadCount = 0,
  copilotReviewRoundCount = 0,
  ciStatus,
  lastCopilotRoundMaxSignal = null,
  failureDetails = [],
  excludedFailureDetails = [],
}) {
  const prState = typeof prData?.state === "string" ? prData.state.toUpperCase() : "OPEN";
  const prMerged = prState === "MERGED";
  const prClosed = prState === "CLOSED";

  return normalizeSnapshot({
    prExists: true,
    prNumber: typeof prData?.number === "number" ? prData.number : prNumber,
    prDraft: Boolean(prData?.isDraft),
    prMerged,
    prClosed,
    copilotReviewRequestStatus,
    copilotReviewPresent,
    copilotReviewOnCurrentHead,
    unresolvedThreadCount,
    actionableThreadCount,
    copilotReviewRoundCount,
    lastCopilotRoundMaxSignal,
    ciStatus: ciStatus ?? normalizeCiStatus(prData?.statusCheckRollup),
    failureDetails,
    excludedFailureDetails,
  });
}

function isAutoRerequestEligible(snapshot, state) {
  if (state !== STATE.READY_TO_REREQUEST_REVIEW) return false;
  // A fresh submitted Copilot review on the current head with no unresolved feedback
  // is converged for that head on the automatic path. Auto re-request eligibility
  // re-opens only when the head advances (i.e. review is no longer on current head).
  return !snapshot.copilotReviewOnCurrentHead;
}

/**
 * Normalize a raw snapshot object into a validated, canonical snapshot.
 *
 * Unknown or invalid field values are replaced with safe defaults.
 * Throws if `raw` is not a non-null object.
 *
 * Snapshot schema:
 * - prExists {boolean} — whether a PR was found
 * - prNumber {number|null} — PR number if prExists, otherwise null
 * - prDraft {boolean} — whether the PR is in draft state
 * - prMerged {boolean} — whether the PR has been merged
 * - prClosed {boolean} — whether the PR has been closed without merge
 * - copilotReviewRequestStatus {"requested"|"already-requested"|"unavailable"|"none"|"failed"}
 *     — current known Copilot review-request state, or "none" if unknown
 * - copilotReviewPresent {boolean} — whether at least one Copilot review exists on the PR
 * - copilotReviewOnCurrentHead {boolean} — whether a submitted (non-PENDING) Copilot review
 *     exists for the current head commit; this alone does not prove the current-head
 *     review-request lifecycle is settled, so callers must still check request-state fields
 * - unresolvedThreadCount {number} — total unresolved review-thread count
 * - actionableThreadCount {number} — unresolved threads with non-bot actionable comments
 * - copilotReviewRoundCount {number} — completed Copilot review rounds observed on the PR
 * - ciStatus {"success"|"failure"|"pending"|"none"|"crediblyGreen"} — current CI check rollup status
 * - lastCopilotRoundMaxSignal {"high"|"mid"|"low"|null} — highest signal level across Copilot-authored threads
 * - agentFixStatus {"applied"|null} — agent-provided input: "applied" when code has been fixed
 * - failureDetails {Array<string>} — names of failing visible check-runs from refreshed head-scoped CI evidence
 * - excludedFailureDetails {Array<string>} — names of failing check-runs filtered out by PR-visibility intersection
 *
 * @param {object} raw - raw snapshot input
 * @returns {object} normalized snapshot
 */
const VALID_SIGNAL_LEVELS = new Set(["high", "mid", "low"]);

export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Snapshot must be a non-null object");
  }

  const prExists = Boolean(raw.prExists);

  const copilotReviewOnCurrentHead = Boolean(raw.copilotReviewOnCurrentHead);

  return {
    prExists,
    prNumber: prExists && typeof raw.prNumber === "number" && raw.prNumber > 0
      ? Math.floor(raw.prNumber)
      : null,
    prDraft: Boolean(raw.prDraft),
    prMerged: Boolean(raw.prMerged),
    prClosed: Boolean(raw.prClosed),
    copilotReviewRequestStatus: VALID_REVIEW_REQUEST_STATUSES.has(raw.copilotReviewRequestStatus)
      ? raw.copilotReviewRequestStatus
      : "none",
    copilotReviewPresent: Boolean(raw.copilotReviewPresent) || copilotReviewOnCurrentHead,
    copilotReviewOnCurrentHead,
    unresolvedThreadCount: typeof raw.unresolvedThreadCount === "number" && raw.unresolvedThreadCount >= 0
      ? Math.floor(raw.unresolvedThreadCount)
      : 0,
    actionableThreadCount: typeof raw.actionableThreadCount === "number" && raw.actionableThreadCount >= 0
      ? Math.floor(raw.actionableThreadCount)
      : 0,
    copilotReviewRoundCount: typeof raw.copilotReviewRoundCount === "number" && raw.copilotReviewRoundCount >= 0
      ? Math.floor(raw.copilotReviewRoundCount)
      : 0,
    ciStatus: VALID_CI_STATUSES.has(raw.ciStatus) ? raw.ciStatus : "none",
    lastCopilotRoundMaxSignal: VALID_SIGNAL_LEVELS.has(raw.lastCopilotRoundMaxSignal) ? raw.lastCopilotRoundMaxSignal : null,
    agentFixStatus: raw.agentFixStatus === "applied" ? "applied" : null,
    failureDetails: Array.isArray(raw.failureDetails) ? raw.failureDetails : [],
    excludedFailureDetails: Array.isArray(raw.excludedFailureDetails) ? raw.excludedFailureDetails : [],
  };
}

/**
 * Return the post-request snapshot that should drive the next wait-cycle interpretation
 * once a Copilot review request has been explicitly issued or confirmed.
 *
 * This keeps the handoff helper on the same shared state-machine contract instead of
 * emitting a watch action that contradicts a same-head clean-convergence interpretation.
 * A confirmed request starts a new wait cycle for the current head, so prior
 * current-head clean-review convergence is cleared for handoff purposes while
 * preserving whether a submitted Copilot review has ever been observed on the PR.
 *
 * @param {object} snapshot
 * @param {string} reviewRequestStatus
 * @returns {object}
 */
export function applyConfirmedReviewRequest(snapshot, reviewRequestStatus) {
  const s = normalizeSnapshot(snapshot);

  if (!ACTIVE_REQUEST_STATUSES.has(reviewRequestStatus)) {
    return normalizeSnapshot({ ...s, copilotReviewRequestStatus: reviewRequestStatus });
  }

  return normalizeSnapshot({
    ...s,
    copilotReviewRequestStatus: reviewRequestStatus,
    copilotReviewOnCurrentHead: false,
    copilotReviewPresent: s.copilotReviewPresent,
  });
}

/**
 * Interpret a loop-state snapshot into one current state, allowed next transitions,
 * and a recommended next action.
 *
 * Interpretation is deterministic: the same snapshot always yields the same result.
 * The function normalizes the snapshot before interpreting, so raw inputs are accepted.
 *
 * Key routing guarantees:
 * - unresolvedThreadCount > 0 always routes into fix/reply-resolve flow, never into wait
 * - "unavailable" or "failed" review-request status routes into stop/report states
 * - agentFixStatus "applied" distinguishes fix-needed from already-fixed-needs-reply/resolve
 * - Copilot review request still active (via requested_reviewers or a PENDING current-head Copilot review)
 *   routes into waiting_for_copilot_review until that request is conclusively settled for this head
 *
 * @param {object} snapshot - raw or normalized snapshot
 * @param {object} [refinementConfig] - optional refinement config with low-signal heuristic fields
 * @param {boolean} [refinementConfig.stopOnLowSignal]
 * @param {number} [refinementConfig.lowSignalRoundThreshold]
 * @param {number} [refinementConfig.lowSignalMaxComments]
 * @param {number} [refinementConfig.maxCopilotRounds]
 * @returns {{
 *   state: string,
 *   allowedTransitions: string[],
 *   nextAction: string,
 *   autoRerequestEligible: boolean,
 *   sameHeadCleanConverged: boolean,
 *   roundCapCleanEligible: boolean
 * }}
 */
export function interpretLoopState(snapshot, refinementConfig) {
  const s = normalizeSnapshot(snapshot);

  let state;

  if (!s.prExists) {
    state = STATE.NO_PR;
  } else if (s.prMerged || s.prClosed) {
    state = STATE.DONE;
  } else if (s.prDraft) {
    state = STATE.PR_DRAFT;
  } else if (s.copilotReviewRequestStatus === "unavailable") {
    state = STATE.REVIEW_REQUEST_UNAVAILABLE;
  } else if (s.copilotReviewRequestStatus === "failed") {
    state = STATE.BLOCKED_NEEDS_USER_DECISION;
  }

  // Round-cap enforcement: when maxCopilotRounds is configured and the review-round
  // count has been exhausted, stop re-requests before entering fix/reply-resolve routing.
  // Gating here (before unresolved-thread checks) ensures round cap takes priority over
  // the normal fix loop, including unresolved threads, pending CI, and CI failures.
  //
  // Precedence at the cap: copilotReviewRoundCount counts COMPLETED rounds, so at
  // `>= maxRounds` every permitted Copilot round is already done and any lingering
  // in-flight request (requested/already-requested) is for a forbidden over-cap round.
  // A stale Copilot reviewer assignment must therefore NOT block the clean fallback:
  // when threads are clean and CI is green, route to ROUND_CAP_CLEAN_FALLBACK even if
  // copilotReviewRequestStatus is requested/already-requested. Otherwise a lingering
  // assignment would dead-end the loop at WAITING_FOR_COPILOT_REVIEW waiting for a
  // review that can never come (no further round is permitted past the cap). The
  // pre_approval_gate (current-head clean evidence, enforced elsewhere) reviews any
  // post-cap head change, so this proceeds without skipping review of new code.
  //
  // An in-flight request only still blocks the cap block when the PR is NOT clean
  // (unresolved threads or non-green CI) — that legitimately stays in the fix/wait
  // routing below rather than terminating as a clean fallback.
  //
  // Head-advanced handling: even when the head has advanced past the last submitted
  // Copilot review with clean threads and green CI, re-requesting another Copilot pass
  // is forbidden at the cap, so this routes to ROUND_CAP_CLEAN_FALLBACK (not
  // READY_TO_REREQUEST_REVIEW, which would trigger an illegal auto re-request). The
  // pre_approval_gate handles the current head.
  const maxRounds = refinementConfig?.maxCopilotRounds;
  const reviewInFlight = s.copilotReviewRequestStatus === "requested"
    || s.copilotReviewRequestStatus === "already-requested";
  if (typeof maxRounds === "number" && maxRounds > 0
      && s.copilotReviewRoundCount >= maxRounds
      && state !== STATE.NO_PR && state !== STATE.DONE
      && state !== STATE.PR_DRAFT && state !== STATE.REVIEW_REQUEST_UNAVAILABLE
      && state !== STATE.BLOCKED_NEEDS_USER_DECISION) {
    const ciClean = s.ciStatus === "success" || s.ciStatus === "crediblyGreen";
    const cleanThreads = s.unresolvedThreadCount === 0;
    if (cleanThreads && ciClean) {
      // Clean PR at the cap: proceed to the pre_approval_gate fallback regardless of a
      // lingering Copilot reviewer assignment or an advanced head — no further Copilot
      // round is permitted, so never re-open for re-request or wait on Copilot here.
      state = STATE.ROUND_CAP_CLEAN_FALLBACK;
    } else if (!reviewInFlight) {
      // Not clean and no in-flight request: hard stop at the cap.
      state = STATE.ROUND_CAP_REACHED;
    }
    // Not clean WITH an in-flight request: leave state undecided so the normal
    // fix/reply-resolve/wait routing below handles it (do not force a clean fallback).
  }

  if (state === undefined) {
    if (s.unresolvedThreadCount > 0 && s.agentFixStatus === "applied") {
      // Agent has fixed the code; threads still need reply/resolve on GitHub
      state = STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE;
    } else if (s.unresolvedThreadCount > 0) {
      // Unresolved feedback exists — do not wait; enter fix/reply-resolve handling
      state = STATE.UNRESOLVED_FEEDBACK_PRESENT;
    } else if (s.copilotReviewRequestStatus === "requested" || s.copilotReviewRequestStatus === "already-requested") {
      // A current-head Copilot request is still active/pending and must settle before gate progression.
      state = STATE.WAITING_FOR_COPILOT_REVIEW;
    } else if (s.copilotReviewPresent) {
      // Copilot has reviewed at least once; all threads resolved
      if (isBlockedCiStatus(s.ciStatus)) {
        state = STATE.BLOCKED_NEEDS_USER_DECISION;
      } else if (isWaitingCiStatus(s.ciStatus)) {
        state = STATE.WAITING_FOR_CI;
      } else {
        state = STATE.READY_TO_REREQUEST_REVIEW;
      }
    } else {
      // No Copilot review yet; not currently requested
      if (isBlockedCiStatus(s.ciStatus)) {
        state = STATE.BLOCKED_NEEDS_USER_DECISION;
      } else if (isWaitingCiStatus(s.ciStatus)) {
        state = STATE.WAITING_FOR_CI;
      } else {
        state = STATE.PR_READY_NO_FEEDBACK;
      }
    }
  }


  // Low-signal heuristic: when configured and last Copilot round signal
  // classification is mid or low (not high), suppress re-request.
  // Falls back to actionableThreadCount heuristic when signal data is null.
  const lowSignalApplied =
    refinementConfig?.stopOnLowSignal === true
    && state === STATE.READY_TO_REREQUEST_REVIEW
    && s.copilotReviewRoundCount > (refinementConfig.lowSignalRoundThreshold ?? 3)
    && s.actionableThreadCount <= (refinementConfig.lowSignalMaxComments ?? 2)
    && (
      s.lastCopilotRoundMaxSignal === null
      || s.lastCopilotRoundMaxSignal !== "high"
    );

  if (lowSignalApplied) {
    state = STATE.LOW_SIGNAL_CONVERGED;
  }

  const autoRerequestEligible = isAutoRerequestEligible(s, state);
  const sameHeadCleanConverged = state === STATE.READY_TO_REREQUEST_REVIEW
    && s.copilotReviewOnCurrentHead
    && s.unresolvedThreadCount === 0
    && s.actionableThreadCount === 0;

  let nextAction = NEXT_ACTIONS[state];
  if (sameHeadCleanConverged) {
    nextAction = SAME_HEAD_CLEAN_CONVERGED_NEXT_ACTION;
  }

  const roundCapCleanEligible = state === STATE.ROUND_CAP_CLEAN_FALLBACK;

  return {
    state,
    allowedTransitions: [...TRANSITIONS[state]],
    nextAction,
    autoRerequestEligible,
    sameHeadCleanConverged,
    roundCapCleanEligible,
  };
}

/**
 * Classify a loop interpretation into a higher-level disposition and whether the
 * loop is terminal/stoppable for this head.
 *
 * @param {object} snapshotOrInterpretation - raw snapshot, normalized snapshot, or interpretLoopState() output
 * @returns {{ loopDisposition: string, terminal: boolean }}
 */
export function summarizeLoopInterpretation(snapshotOrInterpretation, refinementConfig) {
  const interpretation = Array.isArray(snapshotOrInterpretation?.allowedTransitions)
    && typeof snapshotOrInterpretation?.state === "string"
    && typeof snapshotOrInterpretation?.nextAction === "string"
    ? snapshotOrInterpretation
    : interpretLoopState(snapshotOrInterpretation, refinementConfig);

  let loopDisposition;

  switch (interpretation.state) {
    case STATE.WAITING_FOR_COPILOT_REVIEW:
    case STATE.WAITING_FOR_CI:
      loopDisposition = DISPOSITION.PENDING;
      break;
    case STATE.UNRESOLVED_FEEDBACK_PRESENT:
    case STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE:
      loopDisposition = DISPOSITION.UNRESOLVED_FEEDBACK;
      break;
    case STATE.REVIEW_REQUEST_UNAVAILABLE:
    case STATE.BLOCKED_NEEDS_USER_DECISION:
    case STATE.ROUND_CAP_REACHED:
      loopDisposition = DISPOSITION.BLOCKED;
      break;
    case STATE.INTERNAL_TOOLING_DIRECT_GATE:
      loopDisposition = DISPOSITION.DIRECT_GATE;
      break;
    case STATE.LOW_SIGNAL_CONVERGED:
    case STATE.ROUND_CAP_CLEAN_FALLBACK:
    case STATE.DONE:
      loopDisposition = DISPOSITION.DONE;
      break;
    case STATE.READY_TO_REREQUEST_REVIEW:
      loopDisposition = interpretation.sameHeadCleanConverged
        ? DISPOSITION.CLEAN_CONVERGED
        : DISPOSITION.ACTION_REQUIRED;
      break;
    default:
      loopDisposition = DISPOSITION.ACTION_REQUIRED;
      break;
  }

  return {
    loopDisposition,
    terminal: loopDisposition === DISPOSITION.CLEAN_CONVERGED
      || loopDisposition === DISPOSITION.BLOCKED
      || loopDisposition === DISPOSITION.DONE,
  };
}
