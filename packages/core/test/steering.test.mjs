import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  STEERING_KIND,
  STEERING_RESULT,
  SAFE_POINT_CATEGORY,
  normalizeSteeringEvent,
  normalizeSteeringState,
  createSteeringState,
  classifySafePoint,
  submitSteering,
  promoteQueuedSteering,
  getEffectiveConstraints,
  resolveEffectiveLoopState,
  getSteeringStatus,
} from "../src/loop/steering.mjs";

import { STATE } from "../src/loop/copilot-loop-state.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides = {}) {
  return normalizeSteeringEvent({
    eventId: "evt-001",
    runId: "run-abc",
    kind: STEERING_KIND.HARD_CONSTRAINT,
    directive: "Do not add new dependencies",
    seq: 1,
    submittedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function makeState(runId = "run-abc") {
  return createSteeringState(runId);
}

// ---------------------------------------------------------------------------
// STEERING_KIND constants
// ---------------------------------------------------------------------------

test("STEERING_KIND exports the four required kinds", () => {
  assert.equal(STEERING_KIND.HARD_CONSTRAINT, "hard_constraint");
  assert.equal(STEERING_KIND.PREFERENCE, "preference");
  assert.equal(STEERING_KIND.CLARIFICATION, "clarification");
  assert.equal(STEERING_KIND.STOP_AT_NEXT_SAFE_GATE, "stop_at_next_safe_gate");
  assert.equal(Object.keys(STEERING_KIND).length, 4);
});

// ---------------------------------------------------------------------------
// STEERING_RESULT constants
// ---------------------------------------------------------------------------

test("STEERING_RESULT exports the five required result values", () => {
  assert.equal(STEERING_RESULT.APPLIED_NOW, "applied_now");
  assert.equal(STEERING_RESULT.QUEUED_FOR_SAFE_POINT, "queued_for_safe_point");
  assert.equal(STEERING_RESULT.REJECTED_UNSAFE_NOW, "rejected_unsafe_now");
  assert.equal(STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING, "rejected_invalid_or_conflicting");
  assert.equal(STEERING_RESULT.NEEDS_HUMAN_DECISION, "needs_human_decision");
  assert.equal(Object.keys(STEERING_RESULT).length, 5);
});

// ---------------------------------------------------------------------------
// normalizeSteeringEvent
// ---------------------------------------------------------------------------

test("normalizeSteeringEvent rejects non-object input", () => {
  assert.throws(() => normalizeSteeringEvent(null), /non-null object/);
  assert.throws(() => normalizeSteeringEvent(undefined), /non-null object/);
  assert.throws(() => normalizeSteeringEvent("string"), /non-null object/);
});

test("normalizeSteeringEvent rejects missing or empty eventId", () => {
  assert.throws(() => normalizeSteeringEvent({ runId: "r", kind: "preference", directive: "x", seq: 1 }), /eventId/);
  assert.throws(() => normalizeSteeringEvent({ eventId: "  ", runId: "r", kind: "preference", directive: "x", seq: 1 }), /eventId/);
});

test("normalizeSteeringEvent rejects missing or empty runId", () => {
  assert.throws(() => normalizeSteeringEvent({ eventId: "e", kind: "preference", directive: "x", seq: 1 }), /runId/);
});

test("normalizeSteeringEvent rejects unknown kind", () => {
  assert.throws(
    () => normalizeSteeringEvent({ eventId: "e", runId: "r", kind: "unknown_kind", directive: "x", seq: 1 }),
    /kind must be one of/,
  );
});

test("normalizeSteeringEvent rejects missing or empty directive", () => {
  assert.throws(
    () => normalizeSteeringEvent({ eventId: "e", runId: "r", kind: "preference", directive: "", seq: 1 }),
    /directive/,
  );
  assert.throws(
    () => normalizeSteeringEvent({ eventId: "e", runId: "r", kind: "preference", directive: "   ", seq: 1 }),
    /directive/,
  );
});

test("normalizeSteeringEvent rejects missing or invalid seq", () => {
  assert.throws(
    () => normalizeSteeringEvent({ eventId: "e", runId: "r", kind: "preference", directive: "x" }),
    /seq/,
  );
  assert.throws(
    () => normalizeSteeringEvent({ eventId: "e", runId: "r", kind: "preference", directive: "x", seq: 0 }),
    /seq/,
  );
  assert.throws(
    () => normalizeSteeringEvent({ eventId: "e", runId: "r", kind: "preference", directive: "x", seq: -1 }),
    /seq/,
  );
});

test("normalizeSteeringEvent trims whitespace from string fields", () => {
  const event = normalizeSteeringEvent({
    eventId: "  evt  ",
    runId: "  run  ",
    kind: "clarification",
    directive: "  some text  ",
    seq: 1,
  });
  assert.equal(event.eventId, "evt");
  assert.equal(event.runId, "run");
  assert.equal(event.directive, "some text");
});

test("normalizeSteeringEvent floors fractional seq", () => {
  const event = normalizeSteeringEvent({
    eventId: "e",
    runId: "r",
    kind: "preference",
    directive: "x",
    seq: 3.9,
  });
  assert.equal(event.seq, 3);
});

test("normalizeSteeringEvent defaults applyMode to immediate", () => {
  const event = makeEvent();
  assert.equal(event.applyMode, "immediate");
});

test("normalizeSteeringEvent accepts next_safe_point applyMode", () => {
  const event = makeEvent({ applyMode: "next_safe_point" });
  assert.equal(event.applyMode, "next_safe_point");
});

test("normalizeSteeringEvent falls back unknown applyMode to immediate", () => {
  const event = makeEvent({ applyMode: "bogus" });
  assert.equal(event.applyMode, "immediate");
});

test("normalizeSteeringEvent uses provided submittedAt", () => {
  const ts = "2026-05-01T12:00:00.000Z";
  const event = makeEvent({ submittedAt: ts });
  assert.equal(event.submittedAt, ts);
});

test("normalizeSteeringEvent generates submittedAt when missing", () => {
  const before = Date.now();
  const event = normalizeSteeringEvent({
    eventId: "e",
    runId: "r",
    kind: "clarification",
    directive: "x",
    seq: 1,
  });
  const after = Date.now();
  const ts = new Date(event.submittedAt).getTime();
  assert.ok(ts >= before && ts <= after, "submittedAt should be a current timestamp");
});

// ---------------------------------------------------------------------------
// normalizeSteeringState
// ---------------------------------------------------------------------------

test("normalizeSteeringState rejects non-object input", () => {
  assert.throws(() => normalizeSteeringState(null), /non-null object/);
  assert.throws(() => normalizeSteeringState("string"), /non-null object/);
});

test("normalizeSteeringState rejects missing runId", () => {
  assert.throws(() => normalizeSteeringState({}), /runId/);
});

test("normalizeSteeringState returns safe defaults for minimal input", () => {
  const state = normalizeSteeringState({ runId: "run-1" });
  assert.equal(state.runId, "run-1");
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.effectiveStack, []);
  assert.deepEqual(state.queuedEvents, []);
  assert.deepEqual(state.resultHistory, []);
  assert.equal(state.latestResult, null);
  assert.equal(state.nextSeq, 1);
});


test("normalizeSteeringState rejects unsupported schemaVersion values", () => {
  assert.throws(
    () => normalizeSteeringState({ runId: "run-1", schemaVersion: 2 }),
    /Unsupported steering state schemaVersion/,
  );
});

test("normalizeSteeringState preserves valid target metadata", () => {
  const state = normalizeSteeringState({
    runId: "run-1",
    target: { repo: "Owner/Repo", pr: 55 },
  });
  assert.deepEqual(state.target, { repo: "owner/repo", pr: 55 });
});

test("normalizeSteeringState rejects malformed target repo slugs", () => {
  for (const repo of [
    "owner/repo/extra",
    "owner\\repo",
    "owner repo/repo",
    "owner/..",
    "./repo",
    "owner/.",
  ]) {
    assert.throws(
      () => normalizeSteeringState({
        runId: "run-1",
        target: { repo, pr: 55 },
      }),
      /owner\/name repo slug/,
    );
  }
});


test("normalizeSteeringState preserves existing arrays", () => {
  const event = makeEvent();
  const resultEntry = {
    eventId: event.eventId,
    seq: event.seq,
    result: STEERING_RESULT.APPLIED_NOW,
    reason: null,
    acknowledgedAt: "2026-01-01T00:00:01.000Z",
  };
  const state = normalizeSteeringState({
    runId: "run-1",
    events: [event],
    effectiveStack: [event],
    queuedEvents: [],
    resultHistory: [resultEntry],
    latestResult: resultEntry,
    nextSeq: 2,
  });
  assert.equal(state.events.length, 1);
  assert.equal(state.effectiveStack.length, 1);
  assert.equal(state.resultHistory.length, 1);
  assert.equal(state.latestResult.result, STEERING_RESULT.APPLIED_NOW);
  assert.equal(state.nextSeq, 2);
});


test("normalizeSteeringState rejects malformed persisted event entries", () => {
  assert.throws(
    () => normalizeSteeringState({
      runId: "run-1",
      events: [{ eventId: "evt-1", runId: "run-1", directive: "x", seq: 1 }],
    }),
    /events\[0\] is invalid/,
  );
});

// ---------------------------------------------------------------------------
// createSteeringState
// ---------------------------------------------------------------------------

test("createSteeringState returns a fresh state with correct defaults", () => {
  const state = createSteeringState("run-xyz");
  assert.equal(state.runId, "run-xyz");
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.target, null);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.effectiveStack, []);
  assert.deepEqual(state.queuedEvents, []);
  assert.deepEqual(state.resultHistory, []);
  assert.equal(state.latestResult, null);
  assert.equal(state.nextSeq, 1);
});

test("createSteeringState accepts normalized target metadata", () => {
  const state = createSteeringState("run-xyz", { repo: "Owner/Repo", pr: 55 });
  assert.deepEqual(state.target, { repo: "owner/repo", pr: 55 });
});

test("createSteeringState rejects empty runId", () => {
  assert.throws(() => createSteeringState(""), /runId/);
  assert.throws(() => createSteeringState("   "), /runId/);
  assert.throws(() => createSteeringState(null), /runId/);
});

// ---------------------------------------------------------------------------
// classifySafePoint
// ---------------------------------------------------------------------------

test("classifySafePoint returns IMMEDIATE for idle/waiting states", () => {
  for (const state of [
    STATE.PR_READY_NO_FEEDBACK,
    STATE.READY_TO_REREQUEST_REVIEW,
    STATE.WAITING_FOR_COPILOT_REVIEW,
    STATE.WAITING_FOR_CI,
  ]) {
    assert.equal(classifySafePoint(state), SAFE_POINT_CATEGORY.IMMEDIATE, `expected IMMEDIATE for ${state}`);
  }
});

test("classifySafePoint returns NEXT_POINT for computing/mutation states", () => {
  for (const state of [
    STATE.PR_DRAFT,
    STATE.UNRESOLVED_FEEDBACK_PRESENT,
    STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE,
  ]) {
    assert.equal(classifySafePoint(state), SAFE_POINT_CATEGORY.NEXT_POINT, `expected NEXT_POINT for ${state}`);
  }
});

test("classifySafePoint returns TERMINAL for terminal/error states", () => {
  for (const state of [
    STATE.NO_PR,
    STATE.DONE,
    STATE.REVIEW_REQUEST_UNAVAILABLE,
    STATE.BLOCKED_NEEDS_USER_DECISION,
  ]) {
    assert.equal(classifySafePoint(state), SAFE_POINT_CATEGORY.TERMINAL, `expected TERMINAL for ${state}`);
  }
});

test("classifySafePoint returns TERMINAL for unknown states", () => {
  assert.equal(classifySafePoint("completely_unknown_state"), SAFE_POINT_CATEGORY.TERMINAL);
  assert.equal(classifySafePoint(undefined), SAFE_POINT_CATEGORY.TERMINAL);
  assert.equal(classifySafePoint(null), SAFE_POINT_CATEGORY.TERMINAL);
});

// ---------------------------------------------------------------------------
// submitSteering — immediate application
// ---------------------------------------------------------------------------

test("submitSteering returns applied_now for hard_constraint at an IMMEDIATE safe point", () => {
  const event = makeEvent({ kind: STEERING_KIND.HARD_CONSTRAINT, seq: 1 });
  const state = makeState("run-abc");
  const { steeringState, result } = submitSteering(event, state, STATE.READY_TO_REREQUEST_REVIEW);

  assert.equal(result.result, STEERING_RESULT.APPLIED_NOW);
  assert.equal(result.eventId, event.eventId);
  assert.equal(result.seq, event.seq);
  assert.equal(result.reason, null);
  assert.ok(typeof result.acknowledgedAt === "string");

  assert.equal(steeringState.effectiveStack.length, 1);
  assert.equal(steeringState.effectiveStack[0].eventId, event.eventId);
  assert.equal(steeringState.events.length, 1);
  assert.equal(steeringState.resultHistory.length, 1);
  assert.equal(steeringState.latestResult.result, STEERING_RESULT.APPLIED_NOW);
  assert.equal(steeringState.nextSeq, 2);
});

test("submitSteering applies preference at a safe point", () => {
  const event = makeEvent({ kind: STEERING_KIND.PREFERENCE, seq: 1 });
  const state = makeState();
  const { result } = submitSteering(event, state, STATE.WAITING_FOR_COPILOT_REVIEW);
  assert.equal(result.result, STEERING_RESULT.APPLIED_NOW);
});

test("submitSteering applies clarification at a safe point", () => {
  const event = makeEvent({ kind: STEERING_KIND.CLARIFICATION, seq: 1 });
  const state = makeState();
  const { result } = submitSteering(event, state, STATE.WAITING_FOR_CI);
  assert.equal(result.result, STEERING_RESULT.APPLIED_NOW);
});

test("submitSteering applies stop_at_next_safe_gate at a safe point", () => {
  const event = makeEvent({ kind: STEERING_KIND.STOP_AT_NEXT_SAFE_GATE, seq: 1 });
  const state = makeState();
  const { steeringState, result } = submitSteering(event, state, STATE.WAITING_FOR_COPILOT_REVIEW);
  assert.equal(result.result, STEERING_RESULT.APPLIED_NOW);
  assert.equal(steeringState.effectiveStack.length, 1);
  assert.equal(steeringState.effectiveStack[0].kind, STEERING_KIND.STOP_AT_NEXT_SAFE_GATE);
});

test("submitSteering treats repeat stop_at_next_safe_gate on an effective run as applied_now no-op", () => {
  const first = makeEvent({ kind: STEERING_KIND.STOP_AT_NEXT_SAFE_GATE, seq: 1 });
  const repeat = makeEvent({
    eventId: "evt-002",
    kind: STEERING_KIND.STOP_AT_NEXT_SAFE_GATE,
    directive: "Repeat stop request",
    seq: 2,
  });
  const state = makeState();

  const { steeringState: afterFirst } = submitSteering(first, state, STATE.WAITING_FOR_COPILOT_REVIEW);
  const { steeringState: afterRepeat, result } = submitSteering(
    repeat,
    afterFirst,
    STATE.WAITING_FOR_COPILOT_REVIEW,
  );

  assert.equal(result.result, STEERING_RESULT.APPLIED_NOW);
  assert.match(result.reason, /already effective/i);
  assert.equal(afterRepeat.effectiveStack.length, 1);
  assert.equal(afterRepeat.events.length, 2);
  assert.equal(afterRepeat.nextSeq, 3);
});

test("submitSteering applies steering at PR_READY_NO_FEEDBACK safe point", () => {
  const event = makeEvent({ seq: 1 });
  const state = makeState();
  const { result } = submitSteering(event, state, STATE.PR_READY_NO_FEEDBACK);
  assert.equal(result.result, STEERING_RESULT.APPLIED_NOW);
});

// ---------------------------------------------------------------------------
// submitSteering — queued for safe point
// ---------------------------------------------------------------------------

test("submitSteering queues steering when loop is actively computing", () => {
  const event = makeEvent({ kind: STEERING_KIND.HARD_CONSTRAINT, seq: 1 });
  const state = makeState();
  const { steeringState, result } = submitSteering(event, state, STATE.UNRESOLVED_FEEDBACK_PRESENT);

  assert.equal(result.result, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0);

  assert.equal(steeringState.effectiveStack.length, 0);
  assert.equal(steeringState.queuedEvents.length, 1);
  assert.equal(steeringState.events.length, 1);
  assert.equal(steeringState.nextSeq, 2);
});

test("submitSteering queues steering when loop is in non-interruptible mutation", () => {
  const event = makeEvent({ seq: 1 });
  const state = makeState();
  const { result } = submitSteering(event, state, STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE);
  assert.equal(result.result, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
});

test("submitSteering queues steering when loop is in PR_DRAFT", () => {
  const event = makeEvent({ seq: 1 });
  const state = makeState();
  const { result } = submitSteering(event, state, STATE.PR_DRAFT);
  assert.equal(result.result, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
});

test("submitSteering queues steering when applyMode is next_safe_point even at a safe point", () => {
  const event = makeEvent({ seq: 1, applyMode: "next_safe_point" });
  const state = makeState();
  const { steeringState, result } = submitSteering(event, state, STATE.READY_TO_REREQUEST_REVIEW);

  assert.equal(result.result, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
  assert.equal(steeringState.queuedEvents.length, 1);
  assert.equal(steeringState.effectiveStack.length, 0);
});

test("submitSteering treats repeat stop_at_next_safe_gate while queued as queued_for_safe_point no-op", () => {
  const first = makeEvent({ kind: STEERING_KIND.STOP_AT_NEXT_SAFE_GATE, seq: 1 });
  const repeat = makeEvent({
    eventId: "evt-002",
    kind: STEERING_KIND.STOP_AT_NEXT_SAFE_GATE,
    directive: "Repeat stop request",
    seq: 2,
  });
  const state = makeState();

  const { steeringState: afterFirst } = submitSteering(first, state, STATE.PR_DRAFT);
  const { steeringState: afterRepeat, result } = submitSteering(repeat, afterFirst, STATE.PR_DRAFT);

  assert.equal(result.result, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
  assert.match(result.reason, /already queued/i);
  assert.equal(afterRepeat.queuedEvents.length, 1);
  assert.equal(afterRepeat.events.length, 2);
  assert.equal(afterRepeat.nextSeq, 3);
});

// ---------------------------------------------------------------------------
// submitSteering — unsafe rejection
// ---------------------------------------------------------------------------

test("submitSteering rejects steering when loop is DONE", () => {
  const event = makeEvent({ seq: 1 });
  const state = makeState();
  const { result } = submitSteering(event, state, STATE.DONE);

  assert.equal(result.result, STEERING_RESULT.REJECTED_UNSAFE_NOW);
  assert.match(result.reason, /already complete/);
});

test("submitSteering rejects steering when loop is review_request_unavailable", () => {
  const event = makeEvent({ seq: 1 });
  const state = makeState();
  const { result } = submitSteering(event, state, STATE.REVIEW_REQUEST_UNAVAILABLE);
  assert.equal(result.result, STEERING_RESULT.REJECTED_UNSAFE_NOW);
  assert.match(result.reason, /terminal/);
});

test("submitSteering rejects steering when there is no active run", () => {
  const event = makeEvent({ seq: 1 });
  const state = makeState();
  const { result } = submitSteering(event, state, STATE.NO_PR);
  assert.equal(result.result, STEERING_RESULT.REJECTED_UNSAFE_NOW);
});

test("submitSteering routes blocked_needs_user_decision to needs_human_decision", () => {
  const event = makeEvent({ seq: 1 });
  const state = makeState();
  const { result } = submitSteering(event, state, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.equal(result.result, STEERING_RESULT.NEEDS_HUMAN_DECISION);
  assert.match(result.reason, /human decision/);
});

// ---------------------------------------------------------------------------
// submitSteering — conflicting/invalid steering handling
// ---------------------------------------------------------------------------

test("submitSteering rejects duplicate hard_constraint directive (case-insensitive)", () => {
  const event1 = makeEvent({ seq: 1, directive: "No new dependencies" });
  const event2 = makeEvent({ eventId: "evt-002", seq: 2, directive: "no new dependencies" });
  const state = makeState();

  const { steeringState: state1 } = submitSteering(event1, state, STATE.READY_TO_REREQUEST_REVIEW);
  const { result } = submitSteering(event2, state1, STATE.READY_TO_REREQUEST_REVIEW);

  assert.equal(result.result, STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING);
  assert.match(result.reason, /[Dd]uplicate/);
});

test("submitSteering rejects duplicate hard_constraint already present in queued events", () => {
  const event1 = makeEvent({ seq: 1, directive: "No new dependencies" });
  const event2 = makeEvent({ eventId: "evt-002", seq: 2, directive: "no new dependencies" });
  const state = makeState();

  const { steeringState: state1 } = submitSteering(event1, state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
  const { result } = submitSteering(event2, state1, STATE.UNRESOLVED_FEEDBACK_PRESENT);

  assert.equal(result.result, STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING);
  assert.match(result.reason, /queued events/i);
});

test("submitSteering does not reject non-duplicate hard_constraint directives", () => {
  const event1 = makeEvent({ seq: 1, directive: "No new dependencies" });
  const event2 = makeEvent({ eventId: "evt-002", seq: 2, directive: "Use TypeScript only" });
  const state = makeState();

  const { steeringState: state1 } = submitSteering(event1, state, STATE.READY_TO_REREQUEST_REVIEW);
  const { result } = submitSteering(event2, state1, STATE.READY_TO_REREQUEST_REVIEW);

  assert.equal(result.result, STEERING_RESULT.APPLIED_NOW);
});

test("submitSteering rejects out-of-order seq", () => {
  const event1 = makeEvent({ seq: 5 });
  let state = makeState();

  // Advance nextSeq to 6
  const { steeringState: state1 } = submitSteering(event1, state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(state1.nextSeq, 6);

  // Reuse seq 3 — out of order
  const event2 = makeEvent({ eventId: "evt-002", seq: 3 });
  const { result } = submitSteering(event2, state1, STATE.READY_TO_REREQUEST_REVIEW);

  assert.equal(result.result, STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING);
  assert.match(result.reason, /out of order/);
});

test("submitSteering still records rejected events in events and resultHistory", () => {
  const event = makeEvent({ seq: 1 });
  const state = makeState();
  const { steeringState } = submitSteering(event, state, STATE.DONE);

  assert.equal(steeringState.events.length, 1);
  assert.equal(steeringState.resultHistory.length, 1);
  assert.equal(steeringState.resultHistory[0].result, STEERING_RESULT.REJECTED_UNSAFE_NOW);
});


test("submitSteering does not append out-of-order events to the durable events log", () => {
  const accepted = makeEvent({ seq: 5 });
  const rejected = makeEvent({ eventId: "evt-002", seq: 3 });
  const state = makeState();

  const { steeringState: afterAccepted } = submitSteering(accepted, state, STATE.READY_TO_REREQUEST_REVIEW);
  const { steeringState: afterRejected, result } = submitSteering(rejected, afterAccepted, STATE.READY_TO_REREQUEST_REVIEW);

  assert.equal(result.result, STEERING_RESULT.REJECTED_INVALID_OR_CONFLICTING);
  assert.deepEqual(afterRejected.events.map((event) => event.seq), [5]);
  assert.equal(afterRejected.resultHistory.length, 2);
});

// ---------------------------------------------------------------------------
// promoteQueuedSteering — durable state reload / resume behavior
// ---------------------------------------------------------------------------

test("promoteQueuedSteering promotes queued events at a safe point", () => {
  const event = makeEvent({ seq: 1 });
  let state = makeState();

  // Queue the event
  const { steeringState: queued } = submitSteering(event, state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
  assert.equal(queued.queuedEvents.length, 1);
  assert.equal(queued.effectiveStack.length, 0);

  // Loop transitions to a safe point
  const { steeringState: promoted, promoted: promotedEvents } = promoteQueuedSteering(
    queued,
    STATE.READY_TO_REREQUEST_REVIEW,
  );

  assert.equal(promoted.queuedEvents.length, 0);
  assert.equal(promoted.effectiveStack.length, 1);
  assert.equal(promotedEvents.length, 1);
  assert.equal(promoted.latestResult.result, STEERING_RESULT.APPLIED_NOW);
  assert.match(promoted.latestResult.reason, /Promoted from queue/);
});

test("promoteQueuedSteering does not promote when loop is not at a safe point", () => {
  const event = makeEvent({ seq: 1 });
  let state = makeState();

  const { steeringState: queued } = submitSteering(event, state, STATE.UNRESOLVED_FEEDBACK_PRESENT);

  // Still in a non-safe state
  const { steeringState: unchanged, promoted } = promoteQueuedSteering(
    queued,
    STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE,
  );

  assert.equal(unchanged.queuedEvents.length, 1);
  assert.equal(unchanged.effectiveStack.length, 0);
  assert.equal(promoted.length, 0);
});

test("promoteQueuedSteering does not promote at TERMINAL states", () => {
  const event = makeEvent({ seq: 1 });
  let state = makeState();

  const { steeringState: queued } = submitSteering(event, state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
  const { steeringState: unchanged } = promoteQueuedSteering(queued, STATE.DONE);

  assert.equal(unchanged.queuedEvents.length, 1);
  assert.equal(unchanged.effectiveStack.length, 0);
});

test("promoteQueuedSteering is a no-op when queue is empty", () => {
  const state = makeState();
  const { steeringState, promoted } = promoteQueuedSteering(state, STATE.READY_TO_REREQUEST_REVIEW);

  assert.deepEqual(steeringState, state);
  assert.equal(promoted.length, 0);
});

test("promoteQueuedSteering preserves ordering of multiple queued events", () => {
  let state = makeState();

  const event1 = makeEvent({ eventId: "e1", seq: 1, directive: "No new dependencies" });
  const event2 = makeEvent({ eventId: "e2", seq: 2, directive: "Keep docs unchanged" });

  const { steeringState: s1 } = submitSteering(event1, state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
  const { steeringState: s2 } = submitSteering(event2, s1, STATE.UNRESOLVED_FEEDBACK_PRESENT);

  assert.equal(s2.queuedEvents.length, 2);

  const { steeringState: promoted } = promoteQueuedSteering(s2, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(promoted.effectiveStack.length, 2);
  assert.equal(promoted.effectiveStack[0].eventId, "e1");
  assert.equal(promoted.effectiveStack[1].eventId, "e2");
});

// ---------------------------------------------------------------------------
// Durable state reload / resume behavior
// ---------------------------------------------------------------------------

test("round-trip: serialize and reload steering state preserves all fields", () => {
  const event = makeEvent({ seq: 1 });
  let state = makeState();

  const { steeringState: applied } = submitSteering(event, state, STATE.READY_TO_REREQUEST_REVIEW);

  // Simulate persistence and reload via normalizeSteeringState
  const serialized = JSON.parse(JSON.stringify(applied));
  const reloaded = normalizeSteeringState(serialized);

  assert.equal(reloaded.runId, applied.runId);
  assert.equal(reloaded.nextSeq, applied.nextSeq);
  assert.equal(reloaded.events.length, applied.events.length);
  assert.equal(reloaded.effectiveStack.length, applied.effectiveStack.length);
  assert.equal(reloaded.resultHistory.length, applied.resultHistory.length);
  assert.deepEqual(reloaded.latestResult, applied.latestResult);
});

test("reload: queued events survive serialization and are promoted on resume", () => {
  const event = makeEvent({ seq: 1 });
  let state = makeState();

  const { steeringState: queued } = submitSteering(event, state, STATE.UNRESOLVED_FEEDBACK_PRESENT);

  // Serialize and reload (simulates a process restart between loop steps)
  const reloaded = normalizeSteeringState(JSON.parse(JSON.stringify(queued)));
  assert.equal(reloaded.queuedEvents.length, 1);

  // Resume: loop transitions to a safe point
  const { steeringState: promoted } = promoteQueuedSteering(reloaded, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(promoted.effectiveStack.length, 1);
  assert.equal(promoted.queuedEvents.length, 0);
});

// ---------------------------------------------------------------------------
// getEffectiveConstraints
// ---------------------------------------------------------------------------

test("getEffectiveConstraints returns empty constraints for a fresh state", () => {
  const state = makeState();
  const constraints = getEffectiveConstraints(state);
  assert.deepEqual(constraints.hardConstraints, []);
  assert.deepEqual(constraints.preferences, []);
  assert.deepEqual(constraints.clarifications, []);
  assert.equal(constraints.stopAtNextSafeGate, false);
});

test("getEffectiveConstraints accumulates hard constraints", () => {
  const e1 = makeEvent({ seq: 1, kind: STEERING_KIND.HARD_CONSTRAINT, directive: "Constraint A" });
  const e2 = makeEvent({ eventId: "e2", seq: 2, kind: STEERING_KIND.HARD_CONSTRAINT, directive: "Constraint B" });
  let state = makeState();
  const { steeringState: s1 } = submitSteering(e1, state, STATE.READY_TO_REREQUEST_REVIEW);
  const { steeringState: s2 } = submitSteering(e2, s1, STATE.READY_TO_REREQUEST_REVIEW);
  const constraints = getEffectiveConstraints(s2);
  assert.deepEqual(constraints.hardConstraints, ["Constraint A", "Constraint B"]);
});

test("getEffectiveConstraints separates preferences and clarifications", () => {
  const ep = makeEvent({ seq: 1, kind: STEERING_KIND.PREFERENCE, directive: "Prefer TypeScript" });
  const ec = makeEvent({ eventId: "e2", seq: 2, kind: STEERING_KIND.CLARIFICATION, directive: "Clarify scope" });
  let state = makeState();
  const { steeringState: s1 } = submitSteering(ep, state, STATE.WAITING_FOR_COPILOT_REVIEW);
  const { steeringState: s2 } = submitSteering(ec, s1, STATE.WAITING_FOR_COPILOT_REVIEW);
  const constraints = getEffectiveConstraints(s2);
  assert.deepEqual(constraints.preferences, ["Prefer TypeScript"]);
  assert.deepEqual(constraints.clarifications, ["Clarify scope"]);
  assert.equal(constraints.stopAtNextSafeGate, false);
});

test("getEffectiveConstraints sets stopAtNextSafeGate when stop directive is effective", () => {
  const event = makeEvent({ seq: 1, kind: STEERING_KIND.STOP_AT_NEXT_SAFE_GATE });
  let state = makeState();
  const { steeringState } = submitSteering(event, state, STATE.WAITING_FOR_COPILOT_REVIEW);
  const constraints = getEffectiveConstraints(steeringState);
  assert.equal(constraints.stopAtNextSafeGate, true);
});

// ---------------------------------------------------------------------------
// resolveEffectiveLoopState — loop behavior changes with steering
// ---------------------------------------------------------------------------

test("resolveEffectiveLoopState returns base interpretation when no steering is active", () => {
  const state = makeState();
  const snapshot = { prExists: true, prNumber: 1, prMerged: false, copilotReviewPresent: true, unresolvedThreadCount: 0, ciStatus: "success" };
  const result = resolveEffectiveLoopState(snapshot, state);

  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(result.steeringApplied, false);
  assert.equal(result.effectiveConstraints.stopAtNextSafeGate, false);
});

test("resolveEffectiveLoopState overrides nextAction when stop_at_next_safe_gate is active at a safe point", () => {
  const event = makeEvent({ seq: 1, kind: STEERING_KIND.STOP_AT_NEXT_SAFE_GATE });
  let state = makeState();
  const { steeringState: withStop } = submitSteering(event, state, STATE.WAITING_FOR_COPILOT_REVIEW);

  // Loop is at READY_TO_REREQUEST_REVIEW (an IMMEDIATE safe point)
  const snapshot = { prExists: true, prNumber: 1, copilotReviewPresent: true, unresolvedThreadCount: 0, ciStatus: "success" };
  const result = resolveEffectiveLoopState(snapshot, withStop);

  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(result.steeringApplied, true);
  assert.match(result.nextAction, /Stop at this safe gate/);
  assert.match(result.nextAction, /stop_at_next_safe_gate/);
});

test("resolveEffectiveLoopState surfaces pending stop_at_next_safe_gate when loop is not yet at a safe point", () => {
  const event = makeEvent({ seq: 1, kind: STEERING_KIND.STOP_AT_NEXT_SAFE_GATE });
  let state = makeState();
  const { steeringState: withStop } = submitSteering(event, state, STATE.WAITING_FOR_COPILOT_REVIEW);

  // Loop is actively computing — not a safe point
  const snapshot = { prExists: true, prNumber: 1, copilotReviewPresent: true, unresolvedThreadCount: 2, actionableThreadCount: 2 };
  const result = resolveEffectiveLoopState(snapshot, withStop);

  assert.equal(result.state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
  assert.equal(result.steeringApplied, true);
  assert.equal(result.pendingStopAtNextSafeGate, true);
  assert.equal(result.terminalStopAtNextSafeGate, false);
  assert.match(result.nextAction, /Pending stop_at_next_safe_gate/);
});


test("resolveEffectiveLoopState surfaces terminal stop_at_next_safe_gate when the loop cannot resume", () => {
  const event = makeEvent({ seq: 1, kind: STEERING_KIND.STOP_AT_NEXT_SAFE_GATE });
  let state = makeState();
  const { steeringState: withStop } = submitSteering(event, state, STATE.WAITING_FOR_COPILOT_REVIEW);

  const snapshot = {
    prExists: true,
    prNumber: 1,
    copilotReviewRequestStatus: "failed",
  };
  const result = resolveEffectiveLoopState(snapshot, withStop);

  assert.equal(result.state, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.equal(result.pendingStopAtNextSafeGate, false);
  assert.equal(result.terminalStopAtNextSafeGate, true);
  assert.match(result.nextAction, /inactive because the loop is in terminal state/);
});

test("resolveEffectiveLoopState sets steeringApplied when hard constraint is effective", () => {
  const event = makeEvent({ seq: 1, kind: STEERING_KIND.HARD_CONSTRAINT, directive: "No new deps" });
  let state = makeState();
  const { steeringState } = submitSteering(event, state, STATE.WAITING_FOR_COPILOT_REVIEW);

  const snapshot = { prExists: true, prNumber: 1, copilotReviewPresent: true, unresolvedThreadCount: 0, ciStatus: "success" };
  const result = resolveEffectiveLoopState(snapshot, steeringState);

  assert.equal(result.steeringApplied, true);
  assert.deepEqual(result.effectiveConstraints.hardConstraints, ["No new deps"]);
  assert.deepEqual(result.effectiveConstraints.unknownConstraints, []);
});

test("resolveEffectiveLoopState returns a fresh object each call", () => {
  const state = makeState();
  const snapshot = { prExists: true, prNumber: 1 };
  const r1 = resolveEffectiveLoopState(snapshot, state);
  const r2 = resolveEffectiveLoopState(snapshot, state);
  r1.allowedTransitions.push("mutated");
  assert.notDeepEqual(r1.allowedTransitions, r2.allowedTransitions);
});

// ---------------------------------------------------------------------------
// getSteeringStatus
// ---------------------------------------------------------------------------

test("getSteeringStatus returns full inspection output", () => {
  const event = makeEvent({ seq: 1 });
  let state = makeState();
  const { steeringState } = submitSteering(event, state, STATE.READY_TO_REREQUEST_REVIEW);
  const status = getSteeringStatus(steeringState);

  assert.equal(status.runId, steeringState.runId);
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.eventCount, 1);
  assert.equal(status.queuedCount, 0);
  assert.equal(status.effectiveStackCount, 1);
  assert.ok(status.effectiveConstraints);
  assert.ok(status.latestResult);
  assert.equal(status.latestResult.result, STEERING_RESULT.APPLIED_NOW);
  assert.equal(status.resultHistory.length, 1);
  assert.equal(status.history.length, 1);
  assert.equal(status.nextSeq, 2);
});

test("getSteeringStatus shows queued events correctly", () => {
  const event = makeEvent({ seq: 1 });
  let state = makeState();
  const { steeringState } = submitSteering(event, state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
  const status = getSteeringStatus(steeringState);

  assert.equal(status.queuedCount, 1);
  assert.equal(status.effectiveStackCount, 0);
  assert.equal(status.latestResult.result, STEERING_RESULT.QUEUED_FOR_SAFE_POINT);
});

test("getSteeringStatus for fresh state shows all zeros and no latest result", () => {
  const state = makeState();
  const status = getSteeringStatus(state);

  assert.equal(status.eventCount, 0);
  assert.equal(status.queuedCount, 0);
  assert.equal(status.effectiveStackCount, 0);
  assert.equal(status.latestResult, null);
  assert.deepEqual(status.resultHistory, []);
  assert.deepEqual(status.history, []);
  assert.equal(status.nextSeq, 1);
  assert.equal(status.effectiveConstraints.stopAtNextSafeGate, false);
  assert.deepEqual(status.effectiveConstraints.unknownConstraints, []);
});


test("getEffectiveConstraints surfaces unknown kinds instead of dropping them silently", () => {
  const constraints = getEffectiveConstraints({
    effectiveStack: [{ kind: "future_kind", directive: "Future event", seq: 9 }],
  });

  assert.deepEqual(constraints.unknownConstraints, [{
    kind: "future_kind",
    directive: "Future event",
    seq: 9,
  }]);
});
