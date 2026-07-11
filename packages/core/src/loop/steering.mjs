/**
 * Deterministic mid-flight operator steering contract for active dev loops.
 *
 * This module provides:
 * - STEERING_KIND: stable steering kind constants
 * - STEERING_RESULT: acknowledgement/result constants
 * - SAFE_POINT_CATEGORY: safe-point classification constants
 * - normalizeSteeringEvent: validate and canonicalize a raw steering event
 * - normalizeSteeringState: load and validate persisted steering state
 * - createSteeringState: create a fresh steering state for a new run
 * - classifySafePoint: map a copilot loop state to a safe-point category
 * - submitSteering: process a steering event against current run state
 * - promoteQueuedSteering: apply queued steering when the loop reaches a safe point
 * - getEffectiveConstraints: get the current effective steering constraints
 * - resolveEffectiveLoopState: get loop interpretation augmented with active steering
 * - getSteeringStatus: get full inspection output for a run's steering state
 *
 * The proving target for this first implementation slice is the async Copilot
 * review/fix loop (copilot-loop-state.mjs). Safe-point rules are defined for
 * that loop's state set and the resolveEffectiveLoopState integration changes
 * loop behavior when stop_at_next_safe_gate steering is active.
 */

import { normalizeRepoSlug } from "../github/repo-slug.mjs";
import { STATE, interpretLoopState } from "./copilot-loop-state.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Steering kind constants. */
export const STEERING_KIND = Object.freeze({
  /** A hard requirement that must be respected by subsequent steps. */
  HARD_CONSTRAINT: "hard_constraint",
  /** A preference that should be followed but is not required. */
  PREFERENCE: "preference",
  /** A clarification that does not change requirements but affects interpretation. */
  CLARIFICATION: "clarification",
  /** Request the loop to stop at the next safe approval/mutation gate. */
  STOP_AT_NEXT_SAFE_GATE: "stop_at_next_safe_gate",
});

/** Acknowledgement/result constants for steering events. */
export const STEERING_RESULT = Object.freeze({
  /** Steering was applied immediately to the current run state. */
  APPLIED_NOW: "applied_now",
  /** Steering was queued; will be applied when the loop reaches the next safe point. */
  QUEUED_FOR_SAFE_POINT: "queued_for_safe_point",
  /** Steering was rejected because applying it now would be unsafe. */
  REJECTED_UNSAFE_NOW: "rejected_unsafe_now",
  /** Steering was rejected because it is invalid, malformed, or conflicts with existing steering. */
  REJECTED_INVALID_OR_CONFLICTING: "rejected_invalid_or_conflicting",
  /** Steering cannot be resolved automatically and requires human decision. */
  NEEDS_HUMAN_DECISION: "needs_human_decision",
});

/** Safe-point category constants for loop states. */
export const SAFE_POINT_CATEGORY = Object.freeze({
  /** Steering can be applied immediately. */
  IMMEDIATE: "immediate",
  /** Steering must be queued for the next safe point. */
  NEXT_POINT: "next_point",
  /** Steering is rejected because the loop is in a terminal or error state. */
  TERMINAL: "terminal",
});

const CURRENT_SCHEMA_VERSION = 1;
const VALID_STEERING_KINDS = new Set(Object.values(STEERING_KIND));
const VALID_STEERING_RESULTS = new Set(Object.values(STEERING_RESULT));
const VALID_APPLY_MODES = new Set(["immediate", "next_safe_point"]);

// ---------------------------------------------------------------------------
// Safe-point classification
// ---------------------------------------------------------------------------

/**
 * Map a copilot loop state to a safe-point category.
 *
 * Safe-point rules for the async Copilot review/fix loop:
 *
 * IMMEDIATE — between steps / idle / waiting on external state.
 *   Steering can be applied right now without risk of splitting a mutation.
 *   States: pr_ready_no_feedback, waiting_for_copilot_review,
 *           waiting_for_ci, ready_to_rerequest_review
 *
 * NEXT_POINT — actively computing or in a non-interruptible mutation.
 *   Applying steering now could produce a half-applied or inconsistent state.
 *   Queue the event and promote it when the loop next reaches an IMMEDIATE state.
 *   States: pr_draft, unresolved_feedback_present, already_fixed_needs_reply_resolve
 *
 * TERMINAL — run is done, irreversibly failed, or has no active run.
 *   Steering is rejected; it would have no effect or could mask a real error.
 *   States: no_pr, done, review_request_unavailable, blocked_needs_user_decision
 *
 * @param {string} loopState - a copilot loop STATE value
 * @returns {"immediate"|"next_point"|"terminal"}
 */
export function classifySafePoint(loopState) {
  switch (loopState) {
    // Between steps / idle
    case STATE.PR_READY_NO_FEEDBACK:
    case STATE.READY_TO_REREQUEST_REVIEW:
    // Waiting on external state
    case STATE.WAITING_FOR_COPILOT_REVIEW:
    case STATE.WAITING_FOR_CI:
      return SAFE_POINT_CATEGORY.IMMEDIATE;

    // In a pre-ready state (not yet at a mutation gate)
    case STATE.PR_DRAFT:
    // Actively computing — about to apply fixes to resolve feedback
    case STATE.UNRESOLVED_FEEDBACK_PRESENT:
    // In the middle of a non-interruptible mutation (reply/resolve review threads)
    case STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE:
      return SAFE_POINT_CATEGORY.NEXT_POINT;

    // Terminal states: run is done, error, or has no active run
    case STATE.NO_PR:
    case STATE.DONE:
    case STATE.REVIEW_REQUEST_UNAVAILABLE:
    case STATE.BLOCKED_NEEDS_USER_DECISION:
    default:
      return SAFE_POINT_CATEGORY.TERMINAL;
  }
}

// ---------------------------------------------------------------------------
// Schema normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw steering event into a validated, canonical shape.
 *
 * Schema:
 * - eventId {string} — unique identifier for this event
 * - runId {string} — target run identity
 * - kind {"hard_constraint"|"preference"|"clarification"|"stop_at_next_safe_gate"}
 * - directive {string} — operator payload / directive text
 * - submittedAt {string} — ISO 8601 timestamp
 * - seq {number} — positive integer; monotonically increasing for durable ordering
 * - applyMode {"immediate"|"next_safe_point"} — default "immediate"
 *
 * @param {object} raw
 * @returns {object} normalized event
 * @throws {Error} if required fields are missing or invalid
 */
export function normalizeSteeringEvent(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Steering event must be a non-null object");
  }

  const eventId = typeof raw.eventId === "string" && raw.eventId.trim().length > 0
    ? raw.eventId.trim()
    : null;
  if (!eventId) {
    throw new Error("Steering event requires a non-empty eventId");
  }

  const runId = typeof raw.runId === "string" && raw.runId.trim().length > 0
    ? raw.runId.trim()
    : null;
  if (!runId) {
    throw new Error("Steering event requires a non-empty runId");
  }

  const kind = VALID_STEERING_KINDS.has(raw.kind) ? raw.kind : null;
  if (!kind) {
    throw new Error(`Steering event kind must be one of: ${[...VALID_STEERING_KINDS].join(", ")}`);
  }

  const directive = typeof raw.directive === "string" && raw.directive.trim().length > 0
    ? raw.directive.trim()
    : null;
  if (!directive) {
    throw new Error("Steering event requires a non-empty directive");
  }

  const submittedAt = typeof raw.submittedAt === "string" && raw.submittedAt.trim().length > 0
    ? raw.submittedAt.trim()
    : new Date().toISOString();

  const seq = typeof raw.seq === "number" && Number.isFinite(raw.seq) && raw.seq > 0
    ? Math.floor(raw.seq)
    : null;
  if (seq === null) {
    throw new Error("Steering event requires a positive integer seq");
  }

  const applyMode = VALID_APPLY_MODES.has(raw.applyMode) ? raw.applyMode : "immediate";

  return { eventId, runId, kind, directive, submittedAt, seq, applyMode };
}

/**
 * Normalize a raw steering state object into a validated, canonical shape.
 *
 * Durable steering state schema:
 * - runId {string} — identifies the target run
 * - schemaVersion {1} — version discriminator for future migration
 * - events {object[]} — ordered log of all submitted events
 * - effectiveStack {object[]} — events currently in effect
 * - queuedEvents {object[]} — events waiting for the next safe point
 * - resultHistory {object[]} — ordered log of all acknowledgement results
 * - latestResult {object|null} — most recent acknowledgement result
 * - nextSeq {number} — next expected seq value for ordering validation
 *
 * @param {object} raw
 * @returns {object} normalized steering state
 * @throws {Error} if required fields are missing
 */
function normalizeSteeringTarget(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("target must be an object when present");
  }

  const repo = normalizeRepoSlug(raw.repo, {
    errorMessage: "target.repo must be a non-empty owner/name repo slug",
  });

  const pr = typeof raw.pr === "number" && Number.isFinite(raw.pr) && raw.pr > 0
    ? Math.floor(raw.pr)
    : null;
  if (pr === null) {
    throw new Error("target.pr must be a positive integer");
  }

  return { repo, pr };
}

function normalizeResultEntry(raw, fieldName) {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${fieldName} entry must be an object`);
  }

  const eventId = typeof raw.eventId === "string" && raw.eventId.trim().length > 0
    ? raw.eventId.trim()
    : null;
  if (!eventId) {
    throw new Error(`${fieldName} entry requires a non-empty eventId`);
  }

  const seq = typeof raw.seq === "number" && Number.isFinite(raw.seq) && raw.seq > 0
    ? Math.floor(raw.seq)
    : null;
  if (seq === null) {
    throw new Error(`${fieldName} entry requires a positive integer seq`);
  }

  const result = VALID_STEERING_RESULTS.has(raw.result) ? raw.result : null;
  if (!result) {
    throw new Error(`${fieldName} entry result must be one of: ${[...VALID_STEERING_RESULTS].join(", ")}`);
  }

  const acknowledgedAt = typeof raw.acknowledgedAt === "string" && raw.acknowledgedAt.trim().length > 0
    ? raw.acknowledgedAt.trim()
    : null;
  if (!acknowledgedAt) {
    throw new Error(`${fieldName} entry requires a non-empty acknowledgedAt timestamp`);
  }

  let reason = null;
  if (raw.reason !== null && raw.reason !== undefined) {
    if (typeof raw.reason !== "string") {
      throw new Error(`${fieldName} entry reason must be a string or null`);
    }
    reason = raw.reason;
  }

  return { eventId, seq, result, reason, acknowledgedAt };
}

function normalizeEventList(rawList, fieldName) {
  if (!Array.isArray(rawList)) {
    return [];
  }
  return rawList.map((entry, index) => {
    try {
      return normalizeSteeringEvent(entry);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${fieldName}[${index}] is invalid: ${detail}`);
    }
  });
}

function normalizeResultList(rawList, fieldName) {
  if (!Array.isArray(rawList)) {
    return [];
  }
  return rawList.map((entry, index) => {
    try {
      return normalizeResultEntry(entry, `${fieldName}[${index}]`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(detail);
    }
  });
}

export function normalizeSteeringState(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Steering state must be a non-null object");
  }

  const runId = typeof raw.runId === "string" && raw.runId.trim().length > 0
    ? raw.runId.trim()
    : null;
  if (!runId) {
    throw new Error("Steering state requires a non-empty runId");
  }

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported steering state schemaVersion '${raw.schemaVersion}'; expected ${CURRENT_SCHEMA_VERSION}`);
  }

  const events = normalizeEventList(raw.events, "events");
  const effectiveStack = normalizeEventList(raw.effectiveStack, "effectiveStack");
  const queuedEvents = normalizeEventList(raw.queuedEvents, "queuedEvents");
  const resultHistory = normalizeResultList(raw.resultHistory, "resultHistory");

  let latestResult = null;
  if (raw.latestResult !== null && raw.latestResult !== undefined) {
    latestResult = normalizeResultEntry(raw.latestResult, "latestResult");
  }

  let target = null;
  if (raw.target !== undefined) {
    try {
      target = normalizeSteeringTarget(raw.target);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`target is invalid: ${detail}`);
    }
  }

  return {
    runId,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    target,
    events,
    effectiveStack,
    queuedEvents,
    resultHistory,
    latestResult,
    nextSeq: typeof raw.nextSeq === "number" && Number.isFinite(raw.nextSeq) && raw.nextSeq > 0
      ? Math.floor(raw.nextSeq)
      : 1,
  };
}

/**
 * Create a fresh steering state for a new run.
 *
 * @param {string} runId
 * @param {{repo:string,pr:number}|null} [target]
 * @returns {object}
 */
export function createSteeringState(runId, target = null) {
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new Error("createSteeringState requires a non-empty runId");
  }
  return {
    runId: runId.trim(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    target: target ? normalizeSteeringTarget(target) : null,
    events: [],
    effectiveStack: [],
    queuedEvents: [],
    resultHistory: [],
    latestResult: null,
    nextSeq: 1,
  };
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Check if a new steering event conflicts with the existing effective stack.
 *
 * Conflict rules for v1:
 * - Exact duplicate hard_constraint directives (case-insensitive) are rejected.
 *   Two hard constraints with different content are allowed (additive stacking).
 *
 * @param {object} event - normalized steering event
 * @param {object[]} effectiveStack - current effective steering events
 * @param {object[]} queuedEvents - current queued steering events
 * @returns {string|null} conflict reason string, or null if no conflict
 */
function detectConflict(event, effectiveStack, queuedEvents = []) {
  if (event.kind !== STEERING_KIND.HARD_CONSTRAINT) {
    return null;
  }

  const existingEvents = [...effectiveStack, ...queuedEvents];
  for (const existing of existingEvents) {
    if (
      existing.kind === STEERING_KIND.HARD_CONSTRAINT
      && existing.directive.toLowerCase() === event.directive.toLowerCase()
    ) {
      const location = effectiveStack.includes(existing) ? "effective stack" : "queued events";
      return `Duplicate hard_constraint directive already present in ${location} (seq ${existing.seq})`;
    }
  }
  return null;
}

function hasStopAtNextSafeGate(events) {
  return events.some((event) => event.kind === STEERING_KIND.STOP_AT_NEXT_SAFE_GATE);
}

// ---------------------------------------------------------------------------
// Steering submission
// ---------------------------------------------------------------------------

/**
 * Process a steering event against current run state and produce an
 * acknowledgement/result plus updated steering state.
 *
 * This is the main entry point for operators submitting mid-flight corrections.
 *
 * Result semantics:
 * - applied_now: event is immediately effective; effectiveStack is updated.
 * - queued_for_safe_point: loop is in a non-safe state; event is queued and
 *   will be promoted by promoteQueuedSteering when the loop reaches a safe point.
 * - rejected_unsafe_now: terminal loop state (done/unavailable/no_pr); steering
 *   would have no effect or could mask a real issue.
 * - rejected_invalid_or_conflicting: event is malformed, has an out-of-order seq,
 *   or exactly duplicates an existing hard_constraint.
 * - needs_human_decision: loop is in blocked_needs_user_decision; human must act
 *   before automated steering can be safely applied.
 *
 * @param {object} event - normalized steering event (from normalizeSteeringEvent)
 * @param {object} steeringState - current steering state (from normalizeSteeringState)
 * @param {string} loopState - current copilot loop state (a STATE constant value)
 * @returns {{ steeringState: object, result: object }}
 */
export function submitSteering(event, steeringState, loopState) {
  const acknowledgedAt = new Date().toISOString();

  // Validate seq ordering
  if (event.seq < steeringState.nextSeq) {
    const ackResult = {
      eventId: event.eventId,
      seq: event.seq,
      result: STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING,
      reason: `Sequence number ${event.seq} is out of order; expected >= ${steeringState.nextSeq}`,
      acknowledgedAt,
    };
    return {
      steeringState: {
        ...steeringState,
        latestResult: ackResult,
        resultHistory: [...steeringState.resultHistory, ackResult],
      },
      result: ackResult,
    };
  }

  // Check for conflicts with existing effective stack
  const conflictReason = detectConflict(event, steeringState.effectiveStack, steeringState.queuedEvents);
  if (conflictReason) {
    const ackResult = {
      eventId: event.eventId,
      seq: event.seq,
      result: STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING,
      reason: conflictReason,
      acknowledgedAt,
    };
    return {
      steeringState: {
        ...steeringState,
        latestResult: ackResult,
        resultHistory: [...steeringState.resultHistory, ackResult],
        events: [...steeringState.events, event],
        nextSeq: Math.max(steeringState.nextSeq, event.seq + 1),
      },
      result: ackResult,
    };
  }

  const safePointCategory = classifySafePoint(loopState);

  if (event.kind === STEERING_KIND.STOP_AT_NEXT_SAFE_GATE) {
    if (hasStopAtNextSafeGate(steeringState.effectiveStack)) {
      const ackResult = {
        eventId: event.eventId,
        seq: event.seq,
        result: STEERING_RESULT.APPLIED_NOW,
        reason: "stop_at_next_safe_gate is already effective for this run",
        acknowledgedAt,
      };
      return {
        steeringState: {
          ...steeringState,
          latestResult: ackResult,
          resultHistory: [...steeringState.resultHistory, ackResult],
          events: [...steeringState.events, event],
          nextSeq: Math.max(steeringState.nextSeq, event.seq + 1),
        },
        result: ackResult,
      };
    }

    if (hasStopAtNextSafeGate(steeringState.queuedEvents)) {
      const ackResult = {
        eventId: event.eventId,
        seq: event.seq,
        result: STEERING_RESULT.QUEUED_FOR_SAFE_POINT,
        reason: "stop_at_next_safe_gate is already queued for the next safe point",
        acknowledgedAt,
      };
      return {
        steeringState: {
          ...steeringState,
          latestResult: ackResult,
          resultHistory: [...steeringState.resultHistory, ackResult],
          events: [...steeringState.events, event],
          nextSeq: Math.max(steeringState.nextSeq, event.seq + 1),
        },
        result: ackResult,
      };
    }
  }

  // Terminal loop states: reject or route to human decision
  if (safePointCategory === SAFE_POINT_CATEGORY.TERMINAL) {
    let result;
    let reason;

    if (loopState === STATE.BLOCKED_NEEDS_USER_DECISION) {
      result = STEERING_RESULT.NEEDS_HUMAN_DECISION;
      reason = "Loop is in blocked_needs_user_decision; human decision is required before steering can be applied";
    } else if (loopState === STATE.DONE) {
      result = STEERING_RESULT.REJECTED_UNSAFE_NOW;
      reason = "Loop run is already complete (done); steering has no effect";
    } else if (loopState === STATE.REVIEW_REQUEST_UNAVAILABLE) {
      result = STEERING_RESULT.REJECTED_UNSAFE_NOW;
      reason = "Loop is in review_request_unavailable terminal state; steering cannot be applied";
    } else {
      result = STEERING_RESULT.REJECTED_UNSAFE_NOW;
      reason = `Loop state '${loopState}' does not have an active run to steer`;
    }

    const ackResult = { eventId: event.eventId, seq: event.seq, result, reason, acknowledgedAt };
    return {
      steeringState: {
        ...steeringState,
        latestResult: ackResult,
        resultHistory: [...steeringState.resultHistory, ackResult],
        events: [...steeringState.events, event],
        nextSeq: Math.max(steeringState.nextSeq, event.seq + 1),
      },
      result: ackResult,
    };
  }

  // Non-safe states or caller-requested deferred application: queue the event
  if (safePointCategory === SAFE_POINT_CATEGORY.NEXT_POINT || event.applyMode === "next_safe_point") {
    const ackResult = {
      eventId: event.eventId,
      seq: event.seq,
      result: STEERING_RESULT.QUEUED_FOR_SAFE_POINT,
      reason: `Loop is in '${loopState}' (not a safe point for immediate application); steering queued for next safe point`,
      acknowledgedAt,
    };
    return {
      steeringState: {
        ...steeringState,
        latestResult: ackResult,
        resultHistory: [...steeringState.resultHistory, ackResult],
        events: [...steeringState.events, event],
        queuedEvents: [...steeringState.queuedEvents, event],
        nextSeq: Math.max(steeringState.nextSeq, event.seq + 1),
      },
      result: ackResult,
    };
  }

  // Safe point and immediate mode: apply now
  const ackResult = {
    eventId: event.eventId,
    seq: event.seq,
    result: STEERING_RESULT.APPLIED_NOW,
    reason: null,
    acknowledgedAt,
  };
  return {
    steeringState: {
      ...steeringState,
      latestResult: ackResult,
      resultHistory: [...steeringState.resultHistory, ackResult],
      events: [...steeringState.events, event],
      effectiveStack: [...steeringState.effectiveStack, event],
      nextSeq: Math.max(steeringState.nextSeq, event.seq + 1),
    },
    result: ackResult,
  };
}

// ---------------------------------------------------------------------------
// Queued steering promotion
// ---------------------------------------------------------------------------

/**
 * Promote queued steering events to the effective stack when the loop reaches
 * a safe point.
 *
 * Call this whenever the loop transitions to a new state. If the new state is
 * an IMMEDIATE safe point and there are queued events, they are moved to the
 * effective stack and their results updated to applied_now.
 *
 * @param {object} steeringState
 * @param {string} loopState - current loop state after the transition
 * @returns {{ steeringState: object, promoted: object[] }}
 */
export function promoteQueuedSteering(steeringState, loopState) {
  if (steeringState.queuedEvents.length === 0) {
    return { steeringState, promoted: [] };
  }

  const category = classifySafePoint(loopState);
  if (category !== SAFE_POINT_CATEGORY.IMMEDIATE) {
    return { steeringState, promoted: [] };
  }

  const promoted = [...steeringState.queuedEvents];
  const now = new Date().toISOString();

  const newResults = promoted.map((event) => ({
    eventId: event.eventId,
    seq: event.seq,
    result: STEERING_RESULT.APPLIED_NOW,
    reason: `Promoted from queue at safe point '${loopState}'`,
    acknowledgedAt: now,
  }));

  const updatedState = {
    ...steeringState,
    queuedEvents: [],
    effectiveStack: [...steeringState.effectiveStack, ...promoted],
    resultHistory: [...steeringState.resultHistory, ...newResults],
    latestResult: newResults.length > 0 ? newResults[newResults.length - 1] : steeringState.latestResult,
  };

  return { steeringState: updatedState, promoted };
}

// ---------------------------------------------------------------------------
// Effective constraints query
// ---------------------------------------------------------------------------

/**
 * Get the current effective steering constraints for a run.
 *
 * Returns a structured view over the effective stack, split by kind.
 *
 * @param {object} steeringState
 * @returns {{ hardConstraints: string[], preferences: string[], clarifications: string[], stopAtNextSafeGate: boolean, unknownConstraints: object[] }}
 */
export function getEffectiveConstraints(steeringState) {
  const hardConstraints = [];
  const preferences = [];
  const clarifications = [];
  const unknownConstraints = [];
  let stopAtNextSafeGate = false;

  for (const event of steeringState.effectiveStack) {
    switch (event.kind) {
      case STEERING_KIND.HARD_CONSTRAINT:
        hardConstraints.push(event.directive);
        break;
      case STEERING_KIND.PREFERENCE:
        preferences.push(event.directive);
        break;
      case STEERING_KIND.CLARIFICATION:
        clarifications.push(event.directive);
        break;
      case STEERING_KIND.STOP_AT_NEXT_SAFE_GATE:
        stopAtNextSafeGate = true;
        break;
      default:
        unknownConstraints.push({
          kind: event.kind,
          directive: event.directive,
          seq: event.seq,
        });
        break;
    }
  }

  return { hardConstraints, preferences, clarifications, stopAtNextSafeGate, unknownConstraints };
}

// ---------------------------------------------------------------------------
// Loop state augmentation with effective steering
// ---------------------------------------------------------------------------

/**
 * Get the loop interpretation augmented with any active steering directives.
 *
 * This is the main integration point between the steering contract and the
 * async Copilot review/fix loop (the first proving target). Call this instead
 * of interpretLoopState when the run may have active steering state.
 *
 * Behavioral change applied by this function:
 * - When stop_at_next_safe_gate is effective and the loop is at an IMMEDIATE
 *   safe point, the nextAction is overridden to direct the loop to stop rather
 *   than continue to the next step.
 *
 * The steeringApplied flag lets callers know whether active steering changed
 * the default interpretation. The effectiveConstraints field exposes all
 * current steering for downstream use (e.g. injecting hard constraints into
 * agent context before a fix step).
 *
 * @param {object} snapshot - raw or normalized loop snapshot
 * @param {object} steeringState - current steering state for this run
 * @param {object} [refinementConfig] - interpreter refinement config; pass a config-derived
 *   `resolveRefinement(config)` so the base interpretation honors gates.preApproval.requireCi:false (#1337).
 * @returns {{ state: string, allowedTransitions: string[], nextAction: string, steeringApplied: boolean, pendingStopAtNextSafeGate: boolean, terminalStopAtNextSafeGate: boolean, effectiveConstraints: object }}
 */
export function resolveEffectiveLoopState(snapshot, steeringState, refinementConfig) {
  const base = interpretLoopState(snapshot, refinementConfig);
  const constraints = getEffectiveConstraints(steeringState);
  const category = classifySafePoint(base.state);

  const steeringApplied = constraints.stopAtNextSafeGate
    || constraints.hardConstraints.length > 0
    || constraints.preferences.length > 0
    || constraints.clarifications.length > 0
    || constraints.unknownConstraints.length > 0;
  const pendingStopAtNextSafeGate = constraints.stopAtNextSafeGate && category === SAFE_POINT_CATEGORY.NEXT_POINT;
  const terminalStopAtNextSafeGate = constraints.stopAtNextSafeGate && category === SAFE_POINT_CATEGORY.TERMINAL;

  let nextAction = base.nextAction;

  if (constraints.stopAtNextSafeGate && category === SAFE_POINT_CATEGORY.IMMEDIATE) {
    nextAction = "Stop at this safe gate: a stop_at_next_safe_gate steering directive is active. Do not proceed to the next loop step.";
  } else if (pendingStopAtNextSafeGate) {
    nextAction = `Pending stop_at_next_safe_gate: stop at the next safe gate. Until then, current state remains '${base.state}' and the immediate action is: ${base.nextAction}`;
  } else if (terminalStopAtNextSafeGate) {
    nextAction = `stop_at_next_safe_gate is currently inactive because the loop is in terminal state '${base.state}'. Current action remains: ${base.nextAction}`;
  }

  return {
    ...base,
    nextAction,
    steeringApplied,
    pendingStopAtNextSafeGate,
    terminalStopAtNextSafeGate,
    effectiveConstraints: constraints,
  };
}

// ---------------------------------------------------------------------------
// Status/inspection output
// ---------------------------------------------------------------------------

/**
 * Get full inspection output for a run's steering state.
 *
 * Returns:
 * - runId: the target run
 * - schemaVersion: for migration awareness
 * - eventCount: total events submitted
 * - queuedCount: events waiting for the next safe point
 * - effectiveStackCount: events currently in effect
 * - effectiveConstraints: structured view over the effective stack
 * - latestResult: most recent acknowledgement/result
 * - resultHistory: all historical acknowledgements
 * - history: all submitted events
 * - nextSeq: next expected sequence number
 *
 * @param {object} steeringState
 * @returns {object}
 */
export function getSteeringStatus(steeringState) {
  const effectiveConstraints = getEffectiveConstraints(steeringState);
  return {
    runId: steeringState.runId,
    ...(steeringState.target ? { target: steeringState.target } : {}),
    schemaVersion: steeringState.schemaVersion,
    eventCount: steeringState.events.length,
    queuedCount: steeringState.queuedEvents.length,
    effectiveStackCount: steeringState.effectiveStack.length,
    effectiveConstraints,
    latestResult: steeringState.latestResult,
    resultHistory: steeringState.resultHistory,
    history: steeringState.events,
    nextSeq: steeringState.nextSeq,
  };
}
