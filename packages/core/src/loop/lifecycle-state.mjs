/**
 * Deterministic outer dev-loop lifecycle state model.
 *
 * This module defines the sequential lifecycle phases — issue_intake →
 * refinement → implementation → draft_gate → feedback_resolution →
 * pre_approval_gate → merge — as a consultable graph so skills use
 * machine-resolved state instead of restating the flow in prose.
 *
 * This module provides:
 * - LIFECYCLE_STATE: stable phase name constants
 * - LIFECYCLE_TRANSITIONS: legal transition graph between phases
 * - LIFECYCLE_GRAPH: metadata (start, end, entry, terminal, nonterminal)
 * - LIFECYCLE_NEXT_ACTIONS: recommended next action for each phase
 * - resolveLifecycleState: resolver that maps inputs to one lifecycle phase
 * - getAllowedTransitions: helper to list allowed next phases
 * - COPILOT_INNER_STATE_MAP: maps lifecycle phases to copilot-loop-state.mjs inner states
 *
 * Contract guarantees:
 * - One deterministic lifecycle phase per normalized input set
 * - Ambiguous or incomplete inputs fall back to issue_intake
 * - Transition graph enforces legal phase progression
 * - Purely functional; no I/O or side effects
 *
 * Integration boundary:
 * - Skills call resolveLifecycleState to determine current phase
 * - Copilot-loop-state.mjs remains the inner machine for the Copilot review portion
 * - Lifecycle phases are the outer sequence; inner states are sub-phase detail
 */

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

/**
 * Stable lifecycle phase name constants.
 *
 * These are the sequential outer dev-loop phases from issue intake to merge.
 */
export const LIFECYCLE_STATE = Object.freeze({
  /** Issue normalization, scope confirmation, PR linkage detection. */
  ISSUE_INTAKE: "issue_intake",
  /** Issue refinement: spec elaboration, audit, acceptance criteria hardening. */
  REFINEMENT: "refinement",
  /** Active code implementation (local or Copilot-assisted). */
  IMPLEMENTATION: "implementation",
  /** Draft gate review before marking PR ready for review. */
  DRAFT_GATE: "draft_gate",
  /** Review feedback fix/reply/resolve loop. */
  FEEDBACK_RESOLUTION: "feedback_resolution",
  /** Pre-approval gate before merge. */
  PRE_APPROVAL_GATE: "pre_approval_gate",
  /** Final merge step. */
  MERGE: "merge",
});

const LIFECYCLE_STATE_VALUES = Object.freeze(Object.values(LIFECYCLE_STATE));
const LIFECYCLE_STATE_SET = new Set(LIFECYCLE_STATE_VALUES);

/**
 * Legal transitions between lifecycle phases.
 *
 * Each entry lists the phases reachable from the given phase.
 * Terminal states (merge) have no outgoing transitions.
 */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  [LIFECYCLE_STATE.ISSUE_INTAKE]: Object.freeze([
    LIFECYCLE_STATE.REFINEMENT,
    LIFECYCLE_STATE.IMPLEMENTATION,
  ]),
  [LIFECYCLE_STATE.REFINEMENT]: Object.freeze([
    LIFECYCLE_STATE.ISSUE_INTAKE,
    LIFECYCLE_STATE.IMPLEMENTATION,
  ]),
  [LIFECYCLE_STATE.IMPLEMENTATION]: Object.freeze([
    LIFECYCLE_STATE.DRAFT_GATE,
    LIFECYCLE_STATE.FEEDBACK_RESOLUTION,
  ]),
  [LIFECYCLE_STATE.DRAFT_GATE]: Object.freeze([
    LIFECYCLE_STATE.IMPLEMENTATION,
    LIFECYCLE_STATE.FEEDBACK_RESOLUTION,
  ]),
  [LIFECYCLE_STATE.FEEDBACK_RESOLUTION]: Object.freeze([
    LIFECYCLE_STATE.IMPLEMENTATION,
    LIFECYCLE_STATE.PRE_APPROVAL_GATE,
  ]),
  [LIFECYCLE_STATE.PRE_APPROVAL_GATE]: Object.freeze([
    LIFECYCLE_STATE.IMPLEMENTATION,
    LIFECYCLE_STATE.FEEDBACK_RESOLUTION,
    LIFECYCLE_STATE.MERGE,
  ]),
  [LIFECYCLE_STATE.MERGE]: Object.freeze([]),
});

/** Terminal lifecycle phases — no further progression. */
export const LIFECYCLE_TERMINAL_STATES = Object.freeze([
  LIFECYCLE_STATE.MERGE,
]);

/** Nonterminal lifecycle phases — progression still possible. */
export const LIFECYCLE_NONTERMINAL_STATES = Object.freeze([
  LIFECYCLE_STATE.ISSUE_INTAKE,
  LIFECYCLE_STATE.REFINEMENT,
  LIFECYCLE_STATE.IMPLEMENTATION,
  LIFECYCLE_STATE.DRAFT_GATE,
  LIFECYCLE_STATE.FEEDBACK_RESOLUTION,
  LIFECYCLE_STATE.PRE_APPROVAL_GATE,
]);

const LIFECYCLE_TERMINAL_SET = new Set(LIFECYCLE_TERMINAL_STATES);

/** High-level graph metadata for visualization and inspection. */
export const LIFECYCLE_GRAPH = Object.freeze({
  start: Object.freeze({ id: "lifecycle_start", label: "Start", semantic: true }),
  end: Object.freeze({ id: "lifecycle_end", label: "End", semantic: true }),
  entryState: LIFECYCLE_STATE.ISSUE_INTAKE,
  entryStates: Object.freeze([...LIFECYCLE_STATE_VALUES]),
  terminalStates: LIFECYCLE_TERMINAL_STATES,
  nonterminalStates: LIFECYCLE_NONTERMINAL_STATES,
});

/** Recommended next action for each lifecycle phase. */
export const LIFECYCLE_NEXT_ACTIONS = Object.freeze({
  [LIFECYCLE_STATE.ISSUE_INTAKE]:
    "Normalize the issue: confirm scope, detect linked PR, and determine readiness.",
  [LIFECYCLE_STATE.REFINEMENT]:
    "Refine the issue: elaborate spec, run bounded audit if needed, harden acceptance criteria.",
  [LIFECYCLE_STATE.IMPLEMENTATION]:
    "Implement the accepted scope on a feature branch or via Copilot handoff.",
  [LIFECYCLE_STATE.DRAFT_GATE]:
    "Run draft gate review before marking the PR ready for review.",
  [LIFECYCLE_STATE.FEEDBACK_RESOLUTION]:
    "Address review feedback: fix, reply to, and resolve threads on GitHub.",
  [LIFECYCLE_STATE.PRE_APPROVAL_GATE]:
    "Run pre-approval gate review; verify gate evidence, CI, and unresolved threads.",
  [LIFECYCLE_STATE.MERGE]:
    "Merge is authorized; run the final merge step and write the retrospective checkpoint.",
});

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Map an explicit lifecycle phase string to its canonical state value.
 * Returns the canonical state if recognized, otherwise null.
 */
function normalizeLifecycleState(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return LIFECYCLE_STATE_SET.has(trimmed) ? trimmed : null;
}

/**
 * Resolve the current lifecycle phase from authoritative inputs.
 *
 * Input shape:
 * ```js
 * {
 *   phase,              // explicit phase string (overrides infer)
 *   hasLinkedPr,        // boolean: open linked PR exists
 *   prIsDraft,          // boolean: PR is in draft state
 *   hasUnresolvedThreads, // boolean: unresolved review threads exist
 *   preApprovalGatePassed, // boolean: current-head pre_approval_gate clean
 *   mergeAuthorized,    // boolean: explicit merge authorization granted
 *   humanMergeOnly,     // boolean: repo invariant — agent may never merge (fails closed)
 *   isMerged,           // boolean: PR has been merged
 * }
 * ```
 *
 * Returns:
 * ```js
 * {
 *   state: string,              // canonical lifecycle phase
 *   allowedTransitions: string[], // legal next phases
 *   nextAction: string,         // recommended next action
 *   isTerminal: boolean,        // true if merge (no further progression)
 * }
 * ```
 *
 * Resolution order (first-match):
 * 1. Explicit phase → return canonical if recognized, fall through if not
 * 2. Merged → merge (terminal)
 * 3. Merge authorized + pre-approval passed + linked PR → merge
 * 4. Pre-approval passed + PR exists → pre_approval_gate
 * 5. Unresolved threads + PR exists → feedback_resolution
 * 6. Draft PR → implementation
 * 7. Ready PR (not draft) → implementation
 * 8. No linked PR → issue_intake
 */
export function resolveLifecycleState(input = {}) {
  const {
    phase = null,
    hasLinkedPr = false,
    prIsDraft = false,
    hasUnresolvedThreads = false,
    preApprovalGatePassed = false,
    mergeAuthorized = false,
    humanMergeOnly = false,
    isMerged = false,
  } = input;

  // Fail closed: when the repo enforces human-only merge, the agent is never
  // cleared to advance to the merge action — the per-run mergeAuthorized signal
  // is ignored. Also fail closed on a non-boolean `mergeAuthorized` (only an
  // exact `true` clears merge), matching the authoritative
  // `resolveEffectiveMergeAuthorized` gate. An already-merged PR (isMerged) is
  // still terminal below.
  const effectiveMergeAuthorized = humanMergeOnly !== true && mergeAuthorized === true;

  // 1. Explicit phase override — canonical or fail closed
  if (phase !== null && phase !== undefined) {
    const normalized = normalizeLifecycleState(phase);
    if (normalized) {
      return buildResult(normalized);
    }
    // unrecognized phase: fall through to inference
  }

  // 2. Merged → terminal
  if (isMerged) {
    return buildResult(LIFECYCLE_STATE.MERGE);
  }

  // 3. Merge authorized with pre-approval + linked PR → merge
  // (humanMergeOnly forces effectiveMergeAuthorized=false above, so the loop
  // stays at the pre_approval_gate human-merge handoff instead.)
  if (effectiveMergeAuthorized && preApprovalGatePassed && hasLinkedPr) {
    return buildResult(LIFECYCLE_STATE.MERGE);
  }

  // 4. Pre-approval gate passed (but merge not yet authorized)
  if (preApprovalGatePassed && hasLinkedPr) {
    return buildResult(LIFECYCLE_STATE.PRE_APPROVAL_GATE);
  }

  // 5. Unresolved threads exist → feedback resolution
  if (hasUnresolvedThreads && hasLinkedPr) {
    return buildResult(LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
  }

  // 6. Draft PR → implementation
  if (prIsDraft && hasLinkedPr) {
    return buildResult(LIFECYCLE_STATE.IMPLEMENTATION);
  }

  // 7. PR exists (not draft) → implementation
  if (hasLinkedPr && !prIsDraft) {
    return buildResult(LIFECYCLE_STATE.IMPLEMENTATION);
  }

  // 8. No linked PR → issue intake
  return buildResult(LIFECYCLE_STATE.ISSUE_INTAKE);
}

function buildResult(state) {
  const transitions = LIFECYCLE_TRANSITIONS[state] ?? [];
  return {
    state,
    allowedTransitions: [...transitions],
    nextAction: LIFECYCLE_NEXT_ACTIONS[state] ?? "",
    isTerminal: LIFECYCLE_TERMINAL_SET.has(state),
  };
}

// ---------------------------------------------------------------------------
// Transition helpers
// ---------------------------------------------------------------------------

/**
 * Return the allowed next phases for a given lifecycle state.
 * Unknown states return an empty array.
 */
export function getAllowedTransitions(state) {
  if (!LIFECYCLE_STATE_SET.has(state)) return [];
  return [...(LIFECYCLE_TRANSITIONS[state] ?? [])];
}

/**
 * Check whether a transition from one phase to another is legal.
 */
export function isTransitionAllowed(fromState, toState) {
  if (!LIFECYCLE_STATE_SET.has(fromState) || !LIFECYCLE_STATE_SET.has(toState)) {
    return false;
  }
  return LIFECYCLE_TRANSITIONS[fromState].includes(toState);
}

/**
 * Check whether a value is a recognized lifecycle state.
 */
export function isKnownLifecycleState(value) {
  return LIFECYCLE_STATE_SET.has(value);
}

// ---------------------------------------------------------------------------
// Connection to copilot-loop-state.mjs inner machine
// ---------------------------------------------------------------------------

/**
 * Map from outer lifecycle phases to copilot-loop-state.mjs inner machine states.
 *
 * Skills use this mapping to determine which inner-machine states are active
 * during a given lifecycle phase. Not all lifecycle phases have a corresponding
 * inner-machine state (issue_intake and refinement are outer-only).
 *
 * The inner machine is the authority for Copilot review/fix loop states;
 * this mapping is advisory for routing and status reporting.
 */
export const COPILOT_INNER_STATE_MAP = Object.freeze({
  [LIFECYCLE_STATE.ISSUE_INTAKE]: Object.freeze([]),
  [LIFECYCLE_STATE.REFINEMENT]: Object.freeze([]),
  [LIFECYCLE_STATE.IMPLEMENTATION]: Object.freeze([
    "no_pr",
    "pr_draft",
  ]),
  [LIFECYCLE_STATE.DRAFT_GATE]: Object.freeze([
    "pr_ready_no_feedback",
  ]),
  [LIFECYCLE_STATE.FEEDBACK_RESOLUTION]: Object.freeze([
    "waiting_for_copilot_review",
    "unresolved_feedback_present",
    "already_fixed_needs_reply_resolve",
    "ready_to_rerequest_review",
    "waiting_for_ci",
    "review_request_unavailable",
    "blocked_needs_user_decision",
    "round_cap_reached",
  ]),
  [LIFECYCLE_STATE.PRE_APPROVAL_GATE]: Object.freeze([
    "low_signal_converged",
    "round_cap_clean_fallback",
    "internal_tooling_direct_gate",
  ]),
  [LIFECYCLE_STATE.MERGE]: Object.freeze([
    "done",
  ]),
});

/**
 * Resolve the lifecycle phase implied by a given copilot-loop-state.mjs inner state.
 *
 * Returns the lifecycle phase that typically contains the given inner state,
 * or null if the inner state maps to no lifecycle phase.
 */
export function lifecyclePhaseForCopilotState(copilotState) {
  if (typeof copilotState !== "string") return null;

  for (const [phase, innerStates] of Object.entries(COPILOT_INNER_STATE_MAP)) {
    if (innerStates.includes(copilotState)) {
      return phase;
    }
  }
  return null;
}
