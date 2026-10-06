/**
 * Conductor routing contract: deterministic routing and handoff decisions above
 * family-local state machines. See skills/docs/conductor-routing-contract.md.
 *
 * Policy source: conductor-routing-statechart.json (next to this file). The chart
 * lists the routing rules in first-match order; evaluateConductorRouting runs it
 * with the guard predicates defined below and builds the handoff envelope.
 *
 * Contract guarantees:
 * - One deterministic routing outcome per normalized input set.
 * - Ambiguous, conflicting, or insufficient inputs return `needs_reconcile`
 *   rather than a guessed handoff.
 * - The evaluator is purely functional; no I/O or side effects.
 * - evaluateConductorRouting is the single routing authority.
 *
 * Integration boundary:
 * - Starts after active-run identity and ownership are already resolved; it
 *   consumes already-detected family-local lifecycle states as inputs.
 * - Derives the routing outcome directly from states; it does not take a
 *   pre-computed outer-loop action as an input.
 * - Emits routing decisions and handoff envelopes; it does not perform handoff.
 * - Ownership/idempotency rules remain in conductor-ownership.mjs; family-local
 *   state machine semantics remain in copilot-loop-state.mjs etc.
 */

import routingChart from "./conductor-routing-statechart.json" with { type: "json" };

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
// Statechart runner: guards and reason texts for conductor-routing-statechart.json
// ---------------------------------------------------------------------------

const isBlank = (value) => typeof value !== "string" || value.trim().length === 0;
const isLiveOwner = (c) => c.ownershipState === OWNERSHIP_LIVE_OWNER;
const isCopilotDraft = (c) => c.copilotState === "pr_draft";
const isReviewerActive = (c) => REVIEWER_ACTIVE.has(c.reviewerState);
const isCopilotStrongActive = (c) => COPILOT_STRONG_ACTIVE.has(c.copilotState);
const isCopilotWeakActive = (c) => COPILOT_WEAK_ACTIVE.has(c.copilotState);

// Guard predicates named by the chart's `guard` keys.
export const ROUTING_GUARDS = Object.freeze({
  invalidTarget: (c) => c.targetValid === false,
  missingCopilotState: (c) => isBlank(c.copilotState),
  missingReviewerState: (c) => isBlank(c.reviewerState),
  duplicateOwners: (c) => c.ownershipState === OWNERSHIP_DUPLICATE_LOCAL_OWNERS,
  copilotDone: (c) => c.copilotState === "done",
  copilotNoPr: (c) => c.copilotState === "no_pr",
  reviewUnavailable: (c) => c.copilotState === "review_request_unavailable",
  copilotBlocked: (c) => c.copilotState === "blocked_needs_user_decision",
  reviewerBlocked: (c) => c.reviewerState === "blocked_needs_user_decision",
  copilotDraft: isCopilotDraft,
  copilotDraftAndLiveOwner: (c) => isCopilotDraft(c) && isLiveOwner(c),
  waitingForCopilotReview: (c) => c.copilotState === "waiting_for_copilot_review",
  reviewerActive: isReviewerActive,
  reviewerActiveAndLiveOwner: (c) => isReviewerActive(c) && isLiveOwner(c),
  copilotStrongActive: isCopilotStrongActive,
  copilotStrongActiveAndLiveOwner: (c) => isCopilotStrongActive(c) && isLiveOwner(c),
  anyWait: (c) => COPILOT_WAIT.has(c.copilotState) || REVIEWER_WAIT.has(c.reviewerState),
  copilotWeakActive: isCopilotWeakActive,
  copilotWeakActiveAndLiveOwner: (c) => isCopilotWeakActive(c) && isLiveOwner(c),
});

const liveOwnerReason = ({ copilotState, reviewerState }) =>
  `A live owner is already active for this scope; no new handoff issued: copilot_state=${copilotState}, reviewer_state=${reviewerState}`;
const waitReason = ({ copilotState, reviewerState }) =>
  `Outer-loop wait state: copilot_state=${copilotState}, reviewer_state=${reviewerState}`;
const copilotActionReason = ({ copilotState }) => `Copilot loop requires action: copilot_state=${copilotState}`;

// Reason texts keyed by chart arrow rule.
const REASONS = Object.freeze({
  "0a": () => "Target identity is missing or malformed; cannot route without a resolved target",
  "0b": () => "Copilot state is missing or empty; cannot route without family-local state",
  "0c": () => "Reviewer state is missing or empty; cannot route without family-local state",
  1: () => "Ownership state indicates duplicate local owners; reconcile ownership before routing",
  2: () => "PR is merged or closed; conductor loop is complete",
  3: () => "No open PR exists for this scope; cannot route",
  4: () => "Copilot review request returned unavailable; human intervention required",
  5: () => "Copilot loop is blocked and requires human decision",
  6: () => "Reviewer loop is blocked and requires human decision",
  7: liveOwnerReason,
  8: ({ copilotState }) => `PR is in draft state; copilot loop required: copilot_state=${copilotState}`,
  9: waitReason,
  10: liveOwnerReason,
  11: ({ reviewerState }) => `Reviewer loop requires action: reviewer_state=${reviewerState}`,
  12: liveOwnerReason,
  13: copilotActionReason,
  14: waitReason,
  15: liveOwnerReason,
  16: copilotActionReason,
  17: ({ copilotState, reviewerState }) =>
    `Unrecognized combined state: copilot_state=${copilotState}, reviewer_state=${reviewerState}`,
});

const ROUTE_ARROWS = routingChart.states[routingChart.initial].always;

// First `always` arrow whose guard holds wins; the last arrow is unguarded.
// Exported so tests can see which rule fired.
export function selectRoutingArrow({ target, ownershipState, copilotState, reviewerState }) {
  const context = {
    targetValid: normalizeTarget(target) !== null,
    copilotState,
    reviewerState,
    ownershipState: ownershipState ?? null,
  };
  return ROUTE_ARROWS.find((arrow) => arrow.guard === undefined || ROUTING_GUARDS[arrow.guard](context));
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
 *   Settled ownership/idempotency classification from conductor-ownership.
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
  const normalizedTarget = normalizeTarget(target);
  const context = { copilotState, reviewerState };

  const arrow = selectRoutingArrow({ target, ownershipState, copilotState, reviewerState });
  const final = routingChart.states[arrow.target];
  return {
    routingOutcome: arrow.target,
    outerAction: final.meta.outerAction,
    stopReason: arrow.meta.stopReason ?? null,
    handoffEnvelope: buildEnvelope({
      targetIdentity: normalizedTarget ?? describeMalformedTarget(target),
      loopFamily: final.meta.loopFamily ?? LOOP_FAMILY.NONE,
      entrypoint: final.meta.entrypoint ?? ENTRYPOINT.NONE,
      reason: REASONS[arrow.meta.rule](context),
      // pre-check arrows carry no requiredArgs
      requiredArgs: arrow.meta.preCheck ? {} : { ...normalizedTarget },
      requiresLocalIsolation,
      confidence,
    }),
  };
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
