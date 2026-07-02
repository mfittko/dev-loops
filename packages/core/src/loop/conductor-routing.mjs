/**
 * Conductor routing contract: deterministic routing and handoff decisions
 * above family-local state machines.
 *
 * This module provides:
 * - ROUTING_OUTCOME: closed routing outcome taxonomy constants
 * - LOOP_FAMILY: loop family identifier constants
 * - SOURCE_MODE: confidence/source mode constants
 * - ENTRYPOINT: handoff entrypoint identifier constants
 * - STOP_REASON: stop reason code constants (for outer-loop backward compat)
 * - evaluateConductorRouting: shared evaluator/policy entrypoint
 *
 * Contract guarantees:
 * - One deterministic routing outcome per normalized input set
 * - Ambiguous, conflicting, or insufficient inputs return `needs_reconcile`
 *   rather than a guessed handoff
 * - The evaluator is purely functional; no I/O or side effects
 * - Callers use evaluateConductorRouting as the single routing authority
 *
 * Integration boundary (see docs/conductor-routing-contract.md):
 * - This module starts after active-run identity and ownership are already resolved
 * - It consumes already-detected family-local lifecycle states as inputs
 * - It derives the routing outcome directly from states; it does not take a
 *   pre-computed outer-loop action as an input
 * - It emits routing decisions and handoff envelopes; it does not perform handoff
 * - Ownership/idempotency rules remain in conductor-ownership.mjs (#32)
 * - Family-local state machine semantics remain in copilot-loop-state.mjs etc. (#26)
 */

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

/**
 * Closed routing outcome taxonomy constants.
 *
 * Covers all possible routing decisions for an already-targeted active run.
 */
export const ROUTING_OUTCOME = Object.freeze({
  /** Outer-loop wait; re-enter after a bounded wait interval. No handoff needed yet. */
  CONTINUE_CURRENT_WAIT: "continue_current_wait",
  /** Copilot inner loop should handle the next step. */
  HANDOFF_TO_COPILOT_LOOP: "handoff_to_copilot_loop",
  /** Reviewer inner loop should handle the next step. */
  HANDOFF_TO_REVIEWER_LOOP: "handoff_to_reviewer_loop",
  /** A live owner already has control; no new handoff is needed at this cycle. */
  STAY_WITH_CURRENT_LIVE_OWNER: "stay_with_current_live_owner",
  /** Blocked state requiring human intervention before any loop can proceed. */
  STOP_NEEDS_HUMAN: "stop_needs_human",
  /** PR is merged, closed, or fully done; no further loop action is needed. */
  DONE_TERMINAL: "done_terminal",
  /** Ambiguous, conflicting, stale, or insufficient signals; reconcile before routing. */
  NEEDS_RECONCILE: "needs_reconcile",
});

/**
 * Loop family identifier constants.
 */
export const LOOP_FAMILY = Object.freeze({
  /** Copilot review/fix inner loop. */
  COPILOT_LOOP: "copilot_loop",
  /** Reviewer-side inner loop. */
  REVIEWER_LOOP: "reviewer_loop",
  /** Outer conductor loop (wait/checkpoint). */
  OUTER_LOOP: "outer_loop",
  /** No loop family (terminal, blocked, or reconcile states). */
  NONE: null,
});

/**
 * Source/confidence mode constants for routing inputs.
 */
export const SOURCE_MODE = Object.freeze({
  /** State derived from authoritative remote signals. */
  AUTHORITATIVE: "authoritative",
  /** State derived from local records only. */
  LOCAL: "local",
  /** State from a pre-captured snapshot (snapshot-mode testing or replay). */
  SNAPSHOT: "snapshot",
});

/**
 * Handoff entrypoint identifier constants.
 *
 * These identify the specific handler/script that the conductor should invoke
 * for each loop family, without requiring prose to restate the branch logic.
 */
export const ENTRYPOINT = Object.freeze({
  /** copilot-pr-handoff.mjs — main copilot loop re-entry handler. */
  COPILOT_PR_HANDOFF: "copilot_pr_handoff",
  /** reviewer loop handler — reviewer-side inner loop re-entry. */
  REVIEWER_LOOP_HANDLER: "reviewer_loop_handler",
  /** outer-loop.mjs — outer wait/checkpoint re-run. */
  OUTER_LOOP_WAIT: "outer_loop_wait",
  /** No automated entrypoint; human intervention required. */
  NONE: null,
});

/**
 * Stop reason code constants for outer-loop backward-compatibility.
 *
 * Populated in `stopReason` on results whose `outerAction` is "stop".
 */
export const STOP_REASON = Object.freeze({
  PR_NOT_READY: "pr_not_ready",
  COPILOT_BLOCKED: "copilot_blocked",
  REVIEWER_BLOCKED: "reviewer_blocked",
  REVIEW_UNAVAILABLE: "review_unavailable",
  OWNERSHIP_CONFLICT: "ownership_conflict",
  UNKNOWN_STATE: "unknown_state",
});

// ---------------------------------------------------------------------------
// Internal: state classification sets
// ---------------------------------------------------------------------------

// Copilot strong active states: win over reviewer wait states
const COPILOT_STRONG_ACTIVE = new Set([
  "unresolved_feedback_present",
  "already_fixed_needs_reply_resolve",
]);

// Copilot weak active states: yield to reviewer wait states
const COPILOT_WEAK_ACTIVE = new Set([
  "pr_ready_no_feedback",
  "ready_to_rerequest_review",
]);

// Copilot wait states owned by the orchestrator
const COPILOT_WAIT = new Set([
  "waiting_for_copilot_review",
  "waiting_for_ci",
]);

// Reviewer active states requiring handoff or isolation check
const REVIEWER_ACTIVE = new Set([
  "review_requested",
  "determine_review_plan",
  "reviews_running",
  "merge_results",
  "draft_review_ready",
  "draft_review_posted",
  "waiting_for_user_submit",
  "review_invalidated",
]);

// Reviewer wait states owned by the orchestrator
const REVIEWER_WAIT = new Set([
  "submitted_review",
  "waiting_for_author_followup",
  "waiting_for_re_request",
]);

// Ownership state that indicates a live owner is already active
const OWNERSHIP_LIVE_OWNER = "live_owner";

// Ownership state that indicates duplicate local owners (must reconcile)
const OWNERSHIP_DUPLICATE_LOCAL_OWNERS = "duplicate_local_owners";

// ---------------------------------------------------------------------------
// Input normalization helpers
// ---------------------------------------------------------------------------

function normalizeTarget(target) {
  if (!target || typeof target !== "object") {
    return null;
  }
  const { repo, pr } = target;
  if (typeof repo !== "string" || repo.trim().length === 0) {
    return null;
  }
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) {
    return null;
  }
  return { repo: repo.trim().toLowerCase(), pr };
}

function describeMalformedTarget(target) {
  if (!target || typeof target !== "object") {
    return null;
  }

  const repo = typeof target.repo === "string" && target.repo.trim().length > 0
    ? target.repo.trim().toLowerCase()
    : null;
  const pr = typeof target.pr === "number" && Number.isInteger(target.pr) && target.pr > 0
    ? target.pr
    : null;

  return { repo, pr };
}

function resolveConfidence(sourceMode) {
  if (sourceMode === SOURCE_MODE.AUTHORITATIVE) {
    return SOURCE_MODE.AUTHORITATIVE;
  }
  if (sourceMode === SOURCE_MODE.SNAPSHOT) {
    return SOURCE_MODE.SNAPSHOT;
  }
  return SOURCE_MODE.LOCAL;
}

// ---------------------------------------------------------------------------
// Handoff envelope builder
// ---------------------------------------------------------------------------

/**
 * Build a machine-readable handoff envelope.
 *
 * @param {object} params
 * @returns {object}
 */
function buildEnvelope({
  targetIdentity,
  loopFamily,
  entrypoint,
  reason,
  requiredArgs = {},
  requiresLocalIsolation = false,
  confidence = SOURCE_MODE.LOCAL,
}) {
  return {
    targetIdentity,
    loopFamily,
    entrypoint,
    reason,
    requiredArgs,
    requiresLocalIsolation,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Internal: routing helpers
// ---------------------------------------------------------------------------

/**
 * Build a stay_with_current_live_owner result when an active live owner
 * is already handling this scope; no new handoff is needed.
 */
function stayWithLiveOwner({
  normalizedTarget,
  copilotState,
  reviewerState,
  baseArgs,
  requiresLocalIsolation,
  confidence,
}) {
  return {
    routingOutcome: ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER,
    outerAction: "continue_wait",
    stopReason: null,
    handoffEnvelope: buildEnvelope({
      targetIdentity: normalizedTarget,
      loopFamily: LOOP_FAMILY.OUTER_LOOP,
      entrypoint: ENTRYPOINT.OUTER_LOOP_WAIT,
      reason: `A live owner is already active for this scope; no new handoff issued: copilot_state=${copilotState}, reviewer_state=${reviewerState}`,
      requiredArgs: baseArgs,
      requiresLocalIsolation,
      confidence,
    }),
  };
}

function continueCurrentWait({
  normalizedTarget,
  copilotState,
  reviewerState,
  baseArgs,
  requiresLocalIsolation,
  confidence,
}) {
  return {
    routingOutcome: ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT,
    outerAction: "continue_wait",
    stopReason: null,
    handoffEnvelope: buildEnvelope({
      targetIdentity: normalizedTarget,
      loopFamily: LOOP_FAMILY.OUTER_LOOP,
      entrypoint: ENTRYPOINT.OUTER_LOOP_WAIT,
      reason: `Outer-loop wait state: copilot_state=${copilotState}, reviewer_state=${reviewerState}`,
      requiredArgs: baseArgs,
      requiresLocalIsolation,
      confidence,
    }),
  };
}

/**
 * Core routing policy: derive a routing outcome from normalized states.
 *
 * This function contains the real branch logic. Both evaluateConductorRouting
 * (full contract with target validation) and the thin decideOuterAction adapter
 * (target-agnostic) delegate here.
 *
 * Priority order (first match wins):
 *   1. Ownership conflict (duplicate_local_owners) → needs_reconcile
 *   2. Terminal (done) → done_terminal
 *   3. Missing PR (no_pr) → stop_needs_human / pr_not_ready
 *   4. Hard copilot stop (review_request_unavailable, blocked) → stop_needs_human
 *   5. Hard reviewer stop (blocked) → stop_needs_human
 *   6. pr_draft — live-owner check, then handoff (marking requiresLocalIsolation when needed)
 *   7. Copilot explicit review-settle wait (waiting_for_copilot_review) → continue_current_wait
 *   8. Reviewer active states — live-owner check, handoff (marking requiresLocalIsolation when needed)
 *   9. Copilot strong active states — live-owner check, handoff (marking requiresLocalIsolation when needed)
 *   10. Outer-loop wait states (copilot or reviewer)
 *   11. Copilot weak active states (yield to reviewer wait above)
 *   12. Fallback → needs_reconcile / unknown_state
 *
 * @param {object} params
 * @param {{ repo: string, pr: number }} params.normalizedTarget
 * @param {string} params.copilotState
 * @param {string} params.reviewerState
 * @param {string|undefined} params.ownershipState
 * @param {boolean} params.requiresLocalIsolation
 * @param {string} params.confidence
 * @returns {{ routingOutcome: string, outerAction: string, stopReason: string|null, handoffEnvelope: object }}
 */
function routeFromStates({
  normalizedTarget,
  copilotState,
  reviewerState,
  ownershipState,
  requiresLocalIsolation,
  confidence,
}) {
  const baseArgs = { repo: normalizedTarget.repo, pr: normalizedTarget.pr };

  // 1. Ownership conflict — must reconcile before routing
  if (ownershipState === OWNERSHIP_DUPLICATE_LOCAL_OWNERS) {
    return {
      routingOutcome: ROUTING_OUTCOME.NEEDS_RECONCILE,
      outerAction: "stop",
      stopReason: STOP_REASON.OWNERSHIP_CONFLICT,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.NONE,
        entrypoint: ENTRYPOINT.NONE,
        reason: "Ownership state indicates duplicate local owners; reconcile ownership before routing",
        requiredArgs: baseArgs,
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // 2. Terminal
  if (copilotState === "done") {
    return {
      routingOutcome: ROUTING_OUTCOME.DONE_TERMINAL,
      outerAction: "done",
      stopReason: null,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.NONE,
        entrypoint: ENTRYPOINT.NONE,
        reason: "PR is merged or closed; conductor loop is complete",
        requiredArgs: baseArgs,
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // 3. No PR
  if (copilotState === "no_pr") {
    return {
      routingOutcome: ROUTING_OUTCOME.STOP_NEEDS_HUMAN,
      outerAction: "stop",
      stopReason: STOP_REASON.PR_NOT_READY,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.NONE,
        entrypoint: ENTRYPOINT.NONE,
        reason: "No open PR exists for this scope; cannot route",
        requiredArgs: baseArgs,
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // 4. Hard copilot stops
  if (copilotState === "review_request_unavailable") {
    return {
      routingOutcome: ROUTING_OUTCOME.STOP_NEEDS_HUMAN,
      outerAction: "stop",
      stopReason: STOP_REASON.REVIEW_UNAVAILABLE,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.NONE,
        entrypoint: ENTRYPOINT.NONE,
        reason: "Copilot review request returned unavailable; human intervention required",
        requiredArgs: baseArgs,
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  if (copilotState === "blocked_needs_user_decision") {
    return {
      routingOutcome: ROUTING_OUTCOME.STOP_NEEDS_HUMAN,
      outerAction: "stop",
      stopReason: STOP_REASON.COPILOT_BLOCKED,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.NONE,
        entrypoint: ENTRYPOINT.NONE,
        reason: "Copilot loop is blocked and requires human decision",
        requiredArgs: baseArgs,
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // 5. Hard reviewer stop
  if (reviewerState === "blocked_needs_user_decision") {
    return {
      routingOutcome: ROUTING_OUTCOME.STOP_NEEDS_HUMAN,
      outerAction: "stop",
      stopReason: STOP_REASON.REVIEWER_BLOCKED,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.NONE,
        entrypoint: ENTRYPOINT.NONE,
        reason: "Reviewer loop is blocked and requires human decision",
        requiredArgs: baseArgs,
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // 6. pr_draft — hand off to the copilot loop; dirty/detached checkouts
  // are surfaced via handoffEnvelope.requiresLocalIsolation so callers can
  // re-enter from an isolated checkout/worktree instead of treating the seam
  // as a terminal stop.
  if (copilotState === "pr_draft") {
    if (ownershipState === OWNERSHIP_LIVE_OWNER) {
      return stayWithLiveOwner({ normalizedTarget, copilotState, reviewerState, baseArgs, requiresLocalIsolation, confidence });
    }
    return {
      routingOutcome: ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP,
      outerAction: "reenter_copilot_loop",
      stopReason: null,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.COPILOT_LOOP,
        entrypoint: ENTRYPOINT.COPILOT_PR_HANDOFF,
        reason: `PR is in draft state; copilot loop required: copilot_state=${copilotState}`,
        requiredArgs: baseArgs,
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // 7. Copilot explicit review-settle wait — keep watch semantics until settled
  if (copilotState === "waiting_for_copilot_review") {
    return continueCurrentWait({
      normalizedTarget,
      copilotState,
      reviewerState,
      baseArgs,
      requiresLocalIsolation,
      confidence,
    });
  }

  // 8. Reviewer active states
  if (REVIEWER_ACTIVE.has(reviewerState)) {
    if (ownershipState === OWNERSHIP_LIVE_OWNER) {
      return stayWithLiveOwner({ normalizedTarget, copilotState, reviewerState, baseArgs, requiresLocalIsolation, confidence });
    }
    return {
      routingOutcome: ROUTING_OUTCOME.HANDOFF_TO_REVIEWER_LOOP,
      outerAction: "reenter_reviewer_loop",
      stopReason: null,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.REVIEWER_LOOP,
        entrypoint: ENTRYPOINT.REVIEWER_LOOP_HANDLER,
        reason: `Reviewer loop requires action: reviewer_state=${reviewerState}`,
        requiredArgs: baseArgs,
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // 9. Copilot strong active states — win over reviewer wait states
  if (COPILOT_STRONG_ACTIVE.has(copilotState)) {
    if (ownershipState === OWNERSHIP_LIVE_OWNER) {
      return stayWithLiveOwner({ normalizedTarget, copilotState, reviewerState, baseArgs, requiresLocalIsolation, confidence });
    }
    return {
      routingOutcome: ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP,
      outerAction: "reenter_copilot_loop",
      stopReason: null,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.COPILOT_LOOP,
        entrypoint: ENTRYPOINT.COPILOT_PR_HANDOFF,
        reason: `Copilot loop requires action: copilot_state=${copilotState}`,
        requiredArgs: baseArgs,
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // 10. Outer-loop wait states (checked before copilot weak active, since weak yields to reviewer wait)
  if (COPILOT_WAIT.has(copilotState) || REVIEWER_WAIT.has(reviewerState)) {
    return continueCurrentWait({
      normalizedTarget,
      copilotState,
      reviewerState,
      baseArgs,
      requiresLocalIsolation,
      confidence,
    });
  }

  // 11. Copilot weak active states (yield to reviewer wait states above)
  if (COPILOT_WEAK_ACTIVE.has(copilotState)) {
    if (ownershipState === OWNERSHIP_LIVE_OWNER) {
      return stayWithLiveOwner({ normalizedTarget, copilotState, reviewerState, baseArgs, requiresLocalIsolation, confidence });
    }
    return {
      routingOutcome: ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP,
      outerAction: "reenter_copilot_loop",
      stopReason: null,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.COPILOT_LOOP,
        entrypoint: ENTRYPOINT.COPILOT_PR_HANDOFF,
        reason: `Copilot loop requires action: copilot_state=${copilotState}`,
        requiredArgs: baseArgs,
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // 11. Fallback — unrecognized state combination
  return {
    routingOutcome: ROUTING_OUTCOME.NEEDS_RECONCILE,
    outerAction: "stop",
    stopReason: STOP_REASON.UNKNOWN_STATE,
    handoffEnvelope: buildEnvelope({
      targetIdentity: normalizedTarget,
      loopFamily: LOOP_FAMILY.NONE,
      entrypoint: ENTRYPOINT.NONE,
      reason: `Unrecognized combined state: copilot_state=${copilotState}, reviewer_state=${reviewerState}`,
      requiredArgs: baseArgs,
      requiresLocalIsolation,
      confidence,
    }),
  };
}

// ---------------------------------------------------------------------------
// Shared evaluator / policy entrypoint
// ---------------------------------------------------------------------------

/**
 * Evaluate deterministic conductor routing for an already-targeted active run.
 *
 * This is the single routing authority above family-local state machines.
 * The routing outcome is derived directly from the normalized inputs (states +
 * ownership + isolation); it does NOT take a pre-computed outer-loop action.
 *
 * Returns a closed routing outcome, a derived outer-loop action (for backward
 * compat), and a machine-readable handoff envelope. Ambiguous, conflicting,
 * or insufficient inputs return `needs_reconcile` rather than a guessed handoff.
 *
 * @param {object} input
 * @param {{ repo: string, pr: number }} input.target
 *   Explicit target identity (already resolved by the caller).
 * @param {string} [input.ownershipState]
 *   Settled ownership/idempotency classification from conductor-ownership (#32).
 *   "live_owner" → stay_with_current_live_owner (no new handoff this cycle).
 *   "duplicate_local_owners" → needs_reconcile.
 *   Other values or omission → routing continues from states.
 * @param {string} input.copilotState
 *   Already-detected copilot loop lifecycle state (from copilot-loop-state.mjs STATE).
 * @param {string} input.reviewerState
 *   Already-detected reviewer loop lifecycle state (from reviewer-loop-state.mjs REVIEWER_STATE).
 * @param {string} [input.sourceMode]
 *   Source/confidence mode: "authoritative" | "local" | "snapshot".
 *   Defaults to "local".
 * @param {boolean} [input.requiresLocalIsolation]
 *   Whether the checkout is dirty or detached; blocks states that need local execution.
 *   Defaults to false.
 * @returns {{ routingOutcome: string, outerAction: string, stopReason: string|null, handoffEnvelope: object }}
 */
export function evaluateConductorRouting({
  target,
  ownershipState,
  copilotState,
  reviewerState,
  sourceMode,
  requiresLocalIsolation = false,
}) {
  const confidence = resolveConfidence(sourceMode);

  // --- 1. Validate target identity ---
  const normalizedTarget = normalizeTarget(target);
  if (!normalizedTarget) {
    return {
      routingOutcome: ROUTING_OUTCOME.NEEDS_RECONCILE,
      outerAction: "stop",
      stopReason: STOP_REASON.UNKNOWN_STATE,
      handoffEnvelope: buildEnvelope({
        targetIdentity: describeMalformedTarget(target),
        loopFamily: LOOP_FAMILY.NONE,
        entrypoint: ENTRYPOINT.NONE,
        reason: "Target identity is missing or malformed; cannot route without a resolved target",
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // --- 2. Validate required state inputs ---
  if (typeof copilotState !== "string" || copilotState.trim().length === 0) {
    return {
      routingOutcome: ROUTING_OUTCOME.NEEDS_RECONCILE,
      outerAction: "stop",
      stopReason: STOP_REASON.UNKNOWN_STATE,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.NONE,
        entrypoint: ENTRYPOINT.NONE,
        reason: "Copilot state is missing or empty; cannot route without family-local state",
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  if (typeof reviewerState !== "string" || reviewerState.trim().length === 0) {
    return {
      routingOutcome: ROUTING_OUTCOME.NEEDS_RECONCILE,
      outerAction: "stop",
      stopReason: STOP_REASON.UNKNOWN_STATE,
      handoffEnvelope: buildEnvelope({
        targetIdentity: normalizedTarget,
        loopFamily: LOOP_FAMILY.NONE,
        entrypoint: ENTRYPOINT.NONE,
        reason: "Reviewer state is missing or empty; cannot route without family-local state",
        requiresLocalIsolation,
        confidence,
      }),
    };
  }

  // --- 3. Route from normalized states ---
  return routeFromStates({
    normalizedTarget,
    copilotState,
    reviewerState,
    ownershipState,
    requiresLocalIsolation,
    confidence,
  });
}

/**
 * Deterministic outer-loop graph contract above family-local state machines.
 *
 * This module reuses conductor routing as the single source of truth for
 * authoritative outer runtime states. It does not invent a separate outer
 * taxonomy; instead it exposes routing outcomes as the outer state vocabulary,
 * adds graph metadata (semantic Start / End), and provides a stable inspection-
 * and viewer-friendly interpreter surface.
 */

export const OUTER_STATE = Object.freeze({
  CONTINUE_CURRENT_WAIT: ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT,
  HANDOFF_TO_COPILOT_LOOP: ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP,
  HANDOFF_TO_REVIEWER_LOOP: ROUTING_OUTCOME.HANDOFF_TO_REVIEWER_LOOP,
  STAY_WITH_CURRENT_LIVE_OWNER: ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER,
  STOP_NEEDS_HUMAN: ROUTING_OUTCOME.STOP_NEEDS_HUMAN,
  DONE_TERMINAL: ROUTING_OUTCOME.DONE_TERMINAL,
  NEEDS_RECONCILE: ROUTING_OUTCOME.NEEDS_RECONCILE,
});

const OUTER_STATE_VALUES = Object.freeze(Object.values(OUTER_STATE));
const OUTER_STATE_SET = new Set(OUTER_STATE_VALUES);

export const OUTER_TERMINAL_STATES = Object.freeze([
  OUTER_STATE.STOP_NEEDS_HUMAN,
  OUTER_STATE.DONE_TERMINAL,
  OUTER_STATE.NEEDS_RECONCILE,
]);

const OUTER_TERMINAL_STATE_SET = new Set(OUTER_TERMINAL_STATES);
const ALL_OUTER_STATES = Object.freeze([...OUTER_STATE_VALUES]);

export const OUTER_GRAPH = Object.freeze({
  start: Object.freeze({ id: "outer_start", label: "Start", semantic: true }),
  end: Object.freeze({ id: "outer_end", label: "End", semantic: true }),
  entryStates: Object.freeze([...OUTER_STATE_VALUES]),
  terminalStates: OUTER_TERMINAL_STATES,
});

export const OUTER_NEXT_ACTIONS = Object.freeze({
  [OUTER_STATE.CONTINUE_CURRENT_WAIT]: "Remain in outer wait and re-inspect after the bounded interval.",
  [OUTER_STATE.HANDOFF_TO_COPILOT_LOOP]: "Re-enter the Copilot loop.",
  [OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP]: "Re-enter the reviewer loop.",
  [OUTER_STATE.STAY_WITH_CURRENT_LIVE_OWNER]: "Do not issue a new handoff; wait because a live owner is already active.",
  [OUTER_STATE.STOP_NEEDS_HUMAN]: "Stop and require human intervention before continuing.",
  [OUTER_STATE.DONE_TERMINAL]: "End the orchestrator; no further automated action is needed.",
  [OUTER_STATE.NEEDS_RECONCILE]: "Stop and reconcile conflicting or insufficient state before resuming.",
});

export const OUTER_TRANSITIONS = Object.freeze({
  [OUTER_STATE.CONTINUE_CURRENT_WAIT]: ALL_OUTER_STATES,
  [OUTER_STATE.HANDOFF_TO_COPILOT_LOOP]: ALL_OUTER_STATES,
  [OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP]: ALL_OUTER_STATES,
  [OUTER_STATE.STAY_WITH_CURRENT_LIVE_OWNER]: ALL_OUTER_STATES,
  [OUTER_STATE.STOP_NEEDS_HUMAN]: Object.freeze([]),
  [OUTER_STATE.DONE_TERMINAL]: Object.freeze([]),
  [OUTER_STATE.NEEDS_RECONCILE]: Object.freeze([]),
});

export function getAllowedOuterTransitions(state) {
  return Array.isArray(OUTER_TRANSITIONS[state]) ? [...OUTER_TRANSITIONS[state]] : [];
}

function normalizeOuterState(routingOutcome) {
  return OUTER_STATE_SET.has(routingOutcome) ? routingOutcome : OUTER_STATE.NEEDS_RECONCILE;
}

export function isKnownOuterState(value) {
  return OUTER_STATE_SET.has(value);
}

export function interpretOuterLoopState({
  target,
  ownershipState,
  copilotState,
  reviewerState,
  sourceMode,
  requiresLocalIsolation = false,
  routing = null,
} = {}) {
  const effectiveRouting = routing && typeof routing === "object" && typeof routing.routingOutcome === "string"
    ? routing
    : evaluateConductorRouting({
      target,
      ownershipState,
      copilotState,
      reviewerState,
      sourceMode,
      requiresLocalIsolation,
    });

  const state = normalizeOuterState(effectiveRouting.routingOutcome);
  const allowedTransitions = getAllowedOuterTransitions(state);
  const nextAction = OUTER_NEXT_ACTIONS[state] ?? OUTER_NEXT_ACTIONS[OUTER_STATE.NEEDS_RECONCILE];
  const isTerminal = OUTER_TERMINAL_STATE_SET.has(state);

  if (state === OUTER_STATE.NEEDS_RECONCILE && effectiveRouting.routingOutcome !== OUTER_STATE.NEEDS_RECONCILE) {
    return {
      state,
      allowedTransitions: [],
      nextAction,
      isTerminal,
      routingOutcome: OUTER_STATE.NEEDS_RECONCILE,
      outerAction: "stop",
      stopReason: STOP_REASON.UNKNOWN_STATE,
      handoffEnvelope: effectiveRouting.handoffEnvelope,
    };
  }

  return {
    state,
    allowedTransitions,
    nextAction,
    isTerminal,
    routingOutcome: effectiveRouting.routingOutcome,
    outerAction: effectiveRouting.outerAction,
    stopReason: effectiveRouting.stopReason,
    handoffEnvelope: effectiveRouting.handoffEnvelope,
  };
}
