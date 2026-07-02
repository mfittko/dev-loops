import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTING_OUTCOME,
  STOP_REASON,
  OUTER_GRAPH,
  OUTER_NEXT_ACTIONS,
  OUTER_STATE,
  OUTER_TERMINAL_STATES,
  OUTER_TRANSITIONS,
  getAllowedOuterTransitions,
  interpretOuterLoopState,
} from "../src/loop/conductor-routing.mjs";

function makeBaseInput(overrides = {}) {
  return {
    target: { repo: "owner/repo", pr: 42 },
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
    ownershipState: undefined,
    sourceMode: "authoritative",
    requiresLocalIsolation: false,
    ...overrides,
  };
}

test("outer-loop state exports exactly reuse routing outcomes", () => {
  assert.deepEqual(Object.values(OUTER_STATE).sort(), Object.values(ROUTING_OUTCOME).sort());
  assert.equal(OUTER_STATE.CONTINUE_CURRENT_WAIT, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
  assert.equal(OUTER_STATE.HANDOFF_TO_COPILOT_LOOP, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
  assert.equal(OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP, ROUTING_OUTCOME.HANDOFF_TO_REVIEWER_LOOP);
  assert.equal(OUTER_STATE.STAY_WITH_CURRENT_LIVE_OWNER, ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER);
  assert.equal(OUTER_STATE.STOP_NEEDS_HUMAN, ROUTING_OUTCOME.STOP_NEEDS_HUMAN);
  assert.equal(OUTER_STATE.DONE_TERMINAL, ROUTING_OUTCOME.DONE_TERMINAL);
  assert.equal(OUTER_STATE.NEEDS_RECONCILE, ROUTING_OUTCOME.NEEDS_RECONCILE);
});

test("outer-loop graph metadata exports one semantic start and one semantic end", () => {
  assert.deepEqual(OUTER_GRAPH.start, { id: "outer_start", label: "Start", semantic: true });
  assert.deepEqual(OUTER_GRAPH.end, { id: "outer_end", label: "End", semantic: true });
  assert.deepEqual(OUTER_GRAPH.terminalStates, OUTER_TERMINAL_STATES);
  assert.deepEqual([...OUTER_GRAPH.entryStates].sort(), Object.values(OUTER_STATE).sort());
});

test("outer-loop terminal set stays exact", () => {
  assert.deepEqual(OUTER_TERMINAL_STATES, [
    OUTER_STATE.STOP_NEEDS_HUMAN,
    OUTER_STATE.DONE_TERMINAL,
    OUTER_STATE.NEEDS_RECONCILE,
  ]);
});

test("outer-loop transition table stays broad for nonterminal states and empty for terminal states", () => {
  const allStates = Object.values(OUTER_STATE);
  const nonterminalStates = allStates.filter((state) => !OUTER_TERMINAL_STATES.includes(state));

  for (const state of nonterminalStates) {
    assert.deepEqual(OUTER_TRANSITIONS[state], allStates);
    assert.deepEqual(getAllowedOuterTransitions(state), allStates);
    assert.notEqual(getAllowedOuterTransitions(state), OUTER_TRANSITIONS[state]);
  }

  for (const state of OUTER_TERMINAL_STATES) {
    assert.deepEqual(OUTER_TRANSITIONS[state], []);
    assert.deepEqual(getAllowedOuterTransitions(state), []);
  }

  assert.deepEqual(getAllowedOuterTransitions("unknown_state"), []);
});

test("outer-loop next-action text stays defined for every authoritative outer state", () => {
  for (const state of Object.values(OUTER_STATE)) {
    assert.equal(typeof OUTER_NEXT_ACTIONS[state], "string");
    assert.ok(OUTER_NEXT_ACTIONS[state].length > 0);
  }
});

test("interpretOuterLoopState: continue_current_wait", () => {
  const result = interpretOuterLoopState(makeBaseInput({
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
  }));

  assert.equal(result.state, OUTER_STATE.CONTINUE_CURRENT_WAIT);
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.stopReason, null);
  assert.equal(result.isTerminal, false);
  assert.deepEqual(result.allowedTransitions, Object.values(OUTER_STATE));
});

test("interpretOuterLoopState: handoff_to_copilot_loop", () => {
  const result = interpretOuterLoopState(makeBaseInput({
    copilotState: "ready_to_rerequest_review",
    reviewerState: "waiting_for_review_request",
  }));

  assert.equal(result.state, OUTER_STATE.HANDOFF_TO_COPILOT_LOOP);
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.isTerminal, false);
});

test("interpretOuterLoopState: handoff_to_reviewer_loop", () => {
  const result = interpretOuterLoopState(makeBaseInput({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "review_requested",
  }));

  assert.equal(result.state, OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP);
  assert.equal(result.outerAction, "reenter_reviewer_loop");
  assert.equal(result.isTerminal, false);
});

test("interpretOuterLoopState preserves stay_with_current_live_owner distinct from continue_current_wait", () => {
  const result = interpretOuterLoopState(makeBaseInput({
    copilotState: "ready_to_rerequest_review",
    reviewerState: "waiting_for_review_request",
    ownershipState: "live_owner",
  }));

  assert.equal(result.state, OUTER_STATE.STAY_WITH_CURRENT_LIVE_OWNER);
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER);
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.isTerminal, false);
});

test("interpretOuterLoopState preserves needs_reconcile distinct from stop_needs_human", () => {
  const result = interpretOuterLoopState(makeBaseInput({
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
    ownershipState: "duplicate_local_owners",
  }));

  assert.equal(result.state, OUTER_STATE.NEEDS_RECONCILE);
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
  assert.equal(result.outerAction, "stop");
  assert.equal(result.stopReason, STOP_REASON.OWNERSHIP_CONFLICT);
  assert.equal(result.isTerminal, true);
  assert.deepEqual(result.allowedTransitions, []);
});

test("interpretOuterLoopState: stop_needs_human remains distinct for blocked cases", () => {
  const result = interpretOuterLoopState(makeBaseInput({
    copilotState: "review_request_unavailable",
    reviewerState: "waiting_for_review_request",
  }));

  assert.equal(result.state, OUTER_STATE.STOP_NEEDS_HUMAN);
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STOP_NEEDS_HUMAN);
  assert.equal(result.outerAction, "stop");
  assert.equal(result.stopReason, STOP_REASON.REVIEW_UNAVAILABLE);
  assert.equal(result.isTerminal, true);
  assert.deepEqual(result.allowedTransitions, []);
});

test("interpretOuterLoopState: done_terminal", () => {
  const result = interpretOuterLoopState(makeBaseInput({
    copilotState: "done",
    reviewerState: "waiting_for_review_request",
  }));

  assert.equal(result.state, OUTER_STATE.DONE_TERMINAL);
  assert.equal(result.outerAction, "done");
  assert.equal(result.stopReason, null);
  assert.equal(result.isTerminal, true);
});

test("interpretOuterLoopState reuses a precomputed routing result when provided", () => {
  const routing = {
    routingOutcome: ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP,
    outerAction: "reenter_copilot_loop",
    stopReason: null,
    handoffEnvelope: {
      targetIdentity: { repo: "owner/repo", pr: 42 },
      loopFamily: "copilot_loop",
      entrypoint: "copilot_pr_handoff",
      reason: "copilot_needs_action",
      requiredArgs: { repo: "owner/repo", pr: 42 },
      requiresLocalIsolation: false,
      confidence: "authoritative",
    },
  };

  const result = interpretOuterLoopState({
    target: null,
    copilotState: "",
    reviewerState: "",
    routing,
  });

  assert.equal(result.state, OUTER_STATE.HANDOFF_TO_COPILOT_LOOP);
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.stopReason, null);
  assert.equal(result.isTerminal, false);
  assert.deepEqual(result.allowedTransitions, Object.values(OUTER_STATE));
  assert.equal(result.handoffEnvelope, routing.handoffEnvelope);
});

test("interpretOuterLoopState fails closed for malformed inputs", () => {
  const result = interpretOuterLoopState({
    target: null,
    copilotState: "",
    reviewerState: "",
  });

  assert.equal(result.state, OUTER_STATE.NEEDS_RECONCILE);
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
  assert.equal(result.outerAction, "stop");
  assert.equal(result.stopReason, STOP_REASON.UNKNOWN_STATE);
  assert.equal(result.isTerminal, true);
  assert.deepEqual(result.allowedTransitions, []);
});
