import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  ROUTING_OUTCOME,
  LOOP_FAMILY,
  SOURCE_MODE,
  ENTRYPOINT,
  STOP_REASON,
  evaluateConductorRouting,
} from "../src/loop/conductor-routing.mjs";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_TARGET = { repo: "acme/my-repo", pr: 42 };

/**
 * Build a minimal valid input for evaluateConductorRouting.
 * All required fields default to a "continue_wait" scenario (copilot wait state).
 */
function makeInput(overrides = {}) {
  return {
    target: BASE_TARGET,
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ROUTING_OUTCOME constants
// ---------------------------------------------------------------------------

test("ROUTING_OUTCOME exports all seven required outcome values", () => {
  assert.equal(ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT, "continue_current_wait");
  assert.equal(ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP, "handoff_to_copilot_loop");
  assert.equal(ROUTING_OUTCOME.HANDOFF_TO_REVIEWER_LOOP, "handoff_to_reviewer_loop");
  assert.equal(ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER, "stay_with_current_live_owner");
  assert.equal(ROUTING_OUTCOME.STOP_NEEDS_HUMAN, "stop_needs_human");
  assert.equal(ROUTING_OUTCOME.DONE_TERMINAL, "done_terminal");
  assert.equal(ROUTING_OUTCOME.NEEDS_RECONCILE, "needs_reconcile");
  assert.equal(Object.keys(ROUTING_OUTCOME).length, 7);
});

// ---------------------------------------------------------------------------
// LOOP_FAMILY constants
// ---------------------------------------------------------------------------

test("LOOP_FAMILY exports the four required family values", () => {
  assert.equal(LOOP_FAMILY.COPILOT_LOOP, "copilot_loop");
  assert.equal(LOOP_FAMILY.REVIEWER_LOOP, "reviewer_loop");
  assert.equal(LOOP_FAMILY.OUTER_LOOP, "outer_loop");
  assert.equal(LOOP_FAMILY.NONE, null);
  assert.equal(Object.keys(LOOP_FAMILY).length, 4);
});

// ---------------------------------------------------------------------------
// SOURCE_MODE constants
// ---------------------------------------------------------------------------

test("SOURCE_MODE exports the three required mode values", () => {
  assert.equal(SOURCE_MODE.AUTHORITATIVE, "authoritative");
  assert.equal(SOURCE_MODE.LOCAL, "local");
  assert.equal(SOURCE_MODE.SNAPSHOT, "snapshot");
  assert.equal(Object.keys(SOURCE_MODE).length, 3);
});

// ---------------------------------------------------------------------------
// ENTRYPOINT constants
// ---------------------------------------------------------------------------

test("ENTRYPOINT exports the four required entrypoint values", () => {
  assert.equal(ENTRYPOINT.COPILOT_PR_HANDOFF, "copilot_pr_handoff");
  assert.equal(ENTRYPOINT.REVIEWER_LOOP_HANDLER, "reviewer_loop_handler");
  assert.equal(ENTRYPOINT.OUTER_LOOP_WAIT, "outer_loop_wait");
  assert.equal(ENTRYPOINT.NONE, null);
  assert.equal(Object.keys(ENTRYPOINT).length, 4);
});

// ---------------------------------------------------------------------------
// STOP_REASON constants
// ---------------------------------------------------------------------------

test("STOP_REASON exports the required stop reason codes", () => {
  assert.equal(STOP_REASON.PR_NOT_READY, "pr_not_ready");
  assert.equal(STOP_REASON.COPILOT_BLOCKED, "copilot_blocked");
  assert.equal(STOP_REASON.REVIEWER_BLOCKED, "reviewer_blocked");
  assert.equal(STOP_REASON.REVIEW_UNAVAILABLE, "review_unavailable");
  assert.equal(STOP_REASON.OWNERSHIP_CONFLICT, "ownership_conflict");
  assert.equal(STOP_REASON.UNKNOWN_STATE, "unknown_state");
});

// ---------------------------------------------------------------------------
// Scenario 1: outer wait → continue_current_wait
// ---------------------------------------------------------------------------

test("outer wait: copilot waiting_for_copilot_review → continue_current_wait", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
  }));

  assert.equal(result.routingOutcome, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.stopReason, null);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.OUTER_LOOP);
  assert.equal(result.handoffEnvelope.entrypoint, ENTRYPOINT.OUTER_LOOP_WAIT);
  assert.ok(result.handoffEnvelope.reason.length > 0);
  assert.deepEqual(result.handoffEnvelope.requiredArgs, { repo: "acme/my-repo", pr: 42 });
});

test("outer wait: copilot waiting_for_ci → continue_current_wait", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "waiting_for_ci",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.OUTER_LOOP);
});

test("outer wait: reviewer waiting_for_author_followup → continue_current_wait", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "waiting_for_author_followup",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
  assert.equal(result.outerAction, "continue_wait");
});

test("outer wait: reviewer waiting_for_re_request → continue_current_wait", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "waiting_for_re_request",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
});

test("outer wait: reviewer submitted_review → continue_current_wait", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "submitted_review",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
});

// ---------------------------------------------------------------------------
// Scenario 2: reviewer-active routes to reviewer-loop handoff
// ---------------------------------------------------------------------------

test("reviewer active: review_requested → handoff_to_reviewer_loop", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "review_requested",
  }));

  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_REVIEWER_LOOP);
  assert.equal(result.outerAction, "reenter_reviewer_loop");
  assert.equal(result.stopReason, null);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.REVIEWER_LOOP);
  assert.equal(result.handoffEnvelope.entrypoint, ENTRYPOINT.REVIEWER_LOOP_HANDLER);
  assert.ok(result.handoffEnvelope.reason.includes("reviewer_state=review_requested"));
  assert.deepEqual(result.handoffEnvelope.requiredArgs, { repo: "acme/my-repo", pr: 42 });
});

test("reviewer active: review_invalidated → handoff_to_reviewer_loop", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "review_invalidated",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_REVIEWER_LOOP);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.REVIEWER_LOOP);
});

test("copilot review-settle wait: waiting_for_copilot_review wins over reviewer active state", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "waiting_for_copilot_review",
    reviewerState: "review_requested",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
});

test("reviewer active still wins when copilot is waiting_for_ci", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "waiting_for_ci",
    reviewerState: "review_requested",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_REVIEWER_LOOP);
});

// ---------------------------------------------------------------------------
// Scenario 3: Copilot-active routes to Copilot-loop handoff
// ---------------------------------------------------------------------------

test("copilot active: unresolved_feedback_present → handoff_to_copilot_loop", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "unresolved_feedback_present",
    reviewerState: "waiting_for_author_followup",
  }));

  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.stopReason, null);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.COPILOT_LOOP);
  assert.equal(result.handoffEnvelope.entrypoint, ENTRYPOINT.COPILOT_PR_HANDOFF);
  assert.ok(result.handoffEnvelope.reason.includes("copilot_state=unresolved_feedback_present"));
  assert.deepEqual(result.handoffEnvelope.requiredArgs, { repo: "acme/my-repo", pr: 42 });
});

test("copilot active: pr_draft → handoff_to_copilot_loop", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_draft",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.COPILOT_LOOP);
});

test("copilot active: ready_to_rerequest_review → handoff_to_copilot_loop", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "ready_to_rerequest_review",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
});

test("copilot active wins over reviewer wait: unresolved_feedback wins over waiting_for_author_followup", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "unresolved_feedback_present",
    reviewerState: "waiting_for_author_followup",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
});

// ---------------------------------------------------------------------------
// Scenario 4: blocked routes to stop_needs_human
// ---------------------------------------------------------------------------

test("blocked: copilot blocked_needs_user_decision → stop_needs_human", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "blocked_needs_user_decision",
    reviewerState: "waiting_for_review_request",
  }));

  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STOP_NEEDS_HUMAN);
  assert.equal(result.outerAction, "stop");
  assert.equal(result.stopReason, STOP_REASON.COPILOT_BLOCKED);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.NONE);
  assert.equal(result.handoffEnvelope.entrypoint, ENTRYPOINT.NONE);
  assert.ok(result.handoffEnvelope.reason.length > 0);
});

test("blocked: reviewer blocked_needs_user_decision → stop_needs_human", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "blocked_needs_user_decision",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STOP_NEEDS_HUMAN);
  assert.equal(result.stopReason, STOP_REASON.REVIEWER_BLOCKED);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.NONE);
});

test("blocked: review_request_unavailable → stop_needs_human", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "review_request_unavailable",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STOP_NEEDS_HUMAN);
  assert.equal(result.stopReason, STOP_REASON.REVIEW_UNAVAILABLE);
});

test("blocked: no_pr → stop_needs_human", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "no_pr",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STOP_NEEDS_HUMAN);
  assert.equal(result.stopReason, STOP_REASON.PR_NOT_READY);
});

// ---------------------------------------------------------------------------
// Scenario 5: terminal state routes to done_terminal
// ---------------------------------------------------------------------------

test("terminal: copilot done → done_terminal", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "done",
    reviewerState: "waiting_for_review_request",
  }));

  assert.equal(result.routingOutcome, ROUTING_OUTCOME.DONE_TERMINAL);
  assert.equal(result.outerAction, "done");
  assert.equal(result.stopReason, null);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.NONE);
  assert.equal(result.handoffEnvelope.entrypoint, ENTRYPOINT.NONE);
  assert.ok(result.handoffEnvelope.reason.length > 0);
});

// ---------------------------------------------------------------------------
// Scenario 6: local-isolation-needed states stay as handoffs with requiresLocalIsolation
// ---------------------------------------------------------------------------

test("isolation: pr_draft + requiresLocalIsolation=true → handoff_to_copilot_loop with isolation flag", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_draft",
    reviewerState: "waiting_for_review_request",
    requiresLocalIsolation: true,
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.stopReason, null);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.COPILOT_LOOP);
  assert.equal(result.handoffEnvelope.requiresLocalIsolation, true);
});

test("isolation: unresolved_feedback_present + requiresLocalIsolation=true → handoff_to_copilot_loop with isolation flag", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "unresolved_feedback_present",
    reviewerState: "waiting_for_author_followup",
    requiresLocalIsolation: true,
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.stopReason, null);
  assert.equal(result.handoffEnvelope.requiresLocalIsolation, true);
});

test("isolation: reviewer review_requested (needs local) + requiresLocalIsolation=true → handoff_to_reviewer_loop with isolation flag", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "review_requested",
    requiresLocalIsolation: true,
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_REVIEWER_LOOP);
  assert.equal(result.outerAction, "reenter_reviewer_loop");
  assert.equal(result.stopReason, null);
  assert.equal(result.handoffEnvelope.requiresLocalIsolation, true);
});

test("isolation: reviewer waiting_for_user_submit (no local exec needed) + requiresLocalIsolation=true → handoff", () => {
  // waiting_for_user_submit is a reviewer active state but does NOT need local execution
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "waiting_for_user_submit",
    requiresLocalIsolation: true,
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_REVIEWER_LOOP);
});

test("isolation: already_fixed_needs_reply_resolve (no local exec needed) + requiresLocalIsolation=true → handoff", () => {
  // already_fixed_needs_reply_resolve does NOT need local execution
  const result = evaluateConductorRouting(makeInput({
    copilotState: "already_fixed_needs_reply_resolve",
    reviewerState: "waiting_for_review_request",
    requiresLocalIsolation: true,
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
});

// ---------------------------------------------------------------------------
// Scenario 7: live_owner ownership → stay_with_current_live_owner
// ---------------------------------------------------------------------------

test("live_owner: copilot active + ownershipState=live_owner → stay_with_current_live_owner", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "unresolved_feedback_present",
    reviewerState: "waiting_for_author_followup",
    ownershipState: "live_owner",
  }));

  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER);
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.stopReason, null);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.OUTER_LOOP);
  assert.equal(result.handoffEnvelope.entrypoint, ENTRYPOINT.OUTER_LOOP_WAIT);
  assert.ok(result.handoffEnvelope.reason.includes("live owner"));
});

test("live_owner: reviewer active + ownershipState=live_owner → stay_with_current_live_owner", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "review_requested",
    ownershipState: "live_owner",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER);
  assert.equal(result.outerAction, "continue_wait");
});

test("live_owner: copilot weak active + ownershipState=live_owner → stay_with_current_live_owner", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "ready_to_rerequest_review",
    reviewerState: "waiting_for_review_request",
    ownershipState: "live_owner",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER);
});

test("live_owner: pr_draft + ownershipState=live_owner → stay_with_current_live_owner (when workspace clean)", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_draft",
    reviewerState: "waiting_for_review_request",
    ownershipState: "live_owner",
    requiresLocalIsolation: false,
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER);
});

test("live_owner: pr_draft + ownershipState=live_owner + requiresLocalIsolation → stay_with_current_live_owner", () => {
  // live_owner remains authoritative; requiresLocalIsolation stays on the envelope for the next executor
  const result = evaluateConductorRouting(makeInput({
    copilotState: "pr_draft",
    reviewerState: "waiting_for_review_request",
    ownershipState: "live_owner",
    requiresLocalIsolation: true,
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER);
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.stopReason, null);
  assert.equal(result.handoffEnvelope.requiresLocalIsolation, true);
});

test("live_owner: wait states + ownershipState=live_owner → continue_current_wait (unchanged)", () => {
  // live_owner does not change wait-state routing
  const result = evaluateConductorRouting(makeInput({
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
    ownershipState: "live_owner",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.stopReason, null);
});

// ---------------------------------------------------------------------------
// Scenario 8: ambiguous/conflict inputs fail closed to needs_reconcile
// ---------------------------------------------------------------------------

test("conflict: ownership duplicate_local_owners → needs_reconcile", () => {
  const result = evaluateConductorRouting(makeInput({
    ownershipState: "duplicate_local_owners",
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
  }));

  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
  assert.equal(result.stopReason, STOP_REASON.OWNERSHIP_CONFLICT);
  assert.equal(result.handoffEnvelope.loopFamily, LOOP_FAMILY.NONE);
  assert.equal(result.handoffEnvelope.entrypoint, ENTRYPOINT.NONE);
  assert.ok(result.handoffEnvelope.reason.includes("duplicate local owners"));
});

test("conflict: unrecognized combined state → needs_reconcile", () => {
  // A completely unknown copilot state falls through to the reconcile fallback
  const result = evaluateConductorRouting(makeInput({
    copilotState: "completely_unknown_invented_state",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
  assert.equal(result.outerAction, "stop");
  assert.equal(result.stopReason, STOP_REASON.UNKNOWN_STATE);
  assert.ok(result.handoffEnvelope.reason.includes("completely_unknown_invented_state"));
});

test("conflict: both states unknown → needs_reconcile", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "unknown_x",
    reviewerState: "unknown_y",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
});

// ---------------------------------------------------------------------------
// Scenario 9: non-target / noise inputs fail closed
// ---------------------------------------------------------------------------

test("non-target: null target → needs_reconcile", () => {
  const result = evaluateConductorRouting(makeInput({ target: null, requiresLocalIsolation: true }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
  assert.equal(result.handoffEnvelope.targetIdentity, null);
  assert.equal(result.handoffEnvelope.requiresLocalIsolation, true);
  assert.ok(result.handoffEnvelope.reason.includes("Target identity"));
});

test("non-target: missing repo → needs_reconcile", () => {
  const result = evaluateConductorRouting(makeInput({ target: { pr: 42 } }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
  assert.deepEqual(result.handoffEnvelope.targetIdentity, { repo: null, pr: 42 });
});

test("non-target: non-integer pr → needs_reconcile", () => {
  const result = evaluateConductorRouting(makeInput({ target: { repo: "Acme/My-Repo", pr: "not-a-number" } }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
  assert.deepEqual(result.handoffEnvelope.targetIdentity, { repo: "acme/my-repo", pr: null });
});

test("non-target: pr=0 → needs_reconcile", () => {
  const result = evaluateConductorRouting(makeInput({ target: { repo: "acme/my-repo", pr: 0 } }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
});

test("non-target: empty copilotState → needs_reconcile", () => {
  const result = evaluateConductorRouting(makeInput({ copilotState: "", requiresLocalIsolation: true }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
  assert.equal(result.handoffEnvelope.requiresLocalIsolation, true);
});

test("non-target: missing copilotState → needs_reconcile", () => {
  const result = evaluateConductorRouting(makeInput({ copilotState: undefined }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
});

test("non-target: empty reviewerState → needs_reconcile", () => {
  const result = evaluateConductorRouting(makeInput({ reviewerState: "", requiresLocalIsolation: true }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
  assert.equal(result.handoffEnvelope.requiresLocalIsolation, true);
});

test("non-target: extra noise fields on input do not affect valid routing", () => {
  const result = evaluateConductorRouting({
    target: BASE_TARGET,
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
    unknownField: "noise",
    anotherNoise: 12345,
  });
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
});

// ---------------------------------------------------------------------------
// Handoff envelope shape
// ---------------------------------------------------------------------------

test("handoffEnvelope has all required fields for every routing outcome", () => {
  const scenarios = [
    makeInput({ copilotState: "waiting_for_copilot_review", reviewerState: "waiting_for_review_request" }),
    makeInput({ copilotState: "unresolved_feedback_present", reviewerState: "waiting_for_author_followup" }),
    makeInput({ copilotState: "pr_ready_no_feedback", reviewerState: "review_requested" }),
    makeInput({ copilotState: "blocked_needs_user_decision", reviewerState: "waiting_for_review_request" }),
    makeInput({ copilotState: "done", reviewerState: "waiting_for_review_request" }),
    makeInput({ target: null }), // needs_reconcile
    makeInput({ copilotState: "unresolved_feedback_present", reviewerState: "waiting_for_author_followup", ownershipState: "live_owner" }),
  ];

  for (const input of scenarios) {
    const result = evaluateConductorRouting(input);
    const env = result.handoffEnvelope;
    assert.ok(typeof result.routingOutcome === "string", "routingOutcome must be a string");
    assert.ok(typeof result.outerAction === "string", "outerAction must be a string");
    assert.ok("stopReason" in result, "result must have stopReason field");
    assert.ok("targetIdentity" in env, "envelope must have targetIdentity");
    assert.ok("loopFamily" in env, "envelope must have loopFamily");
    assert.ok("entrypoint" in env, "envelope must have entrypoint");
    assert.ok(typeof env.reason === "string" && env.reason.length > 0, "envelope must have non-empty reason");
    assert.ok(typeof env.requiredArgs === "object" && env.requiredArgs !== null, "envelope must have requiredArgs object");
    assert.ok(typeof env.requiresLocalIsolation === "boolean", "envelope must have requiresLocalIsolation boolean");
    assert.ok(typeof env.confidence === "string", "envelope must have confidence string");
  }
});

// ---------------------------------------------------------------------------
// outerAction / stopReason derivation
// ---------------------------------------------------------------------------

test("result.outerAction is 'done' for done_terminal routing outcome", () => {
  const result = evaluateConductorRouting(makeInput({ copilotState: "done" }));
  assert.equal(result.outerAction, "done");
  assert.equal(result.stopReason, null);
});

test("result.outerAction is 'stop' and stopReason is set for stop_needs_human", () => {
  const result = evaluateConductorRouting(makeInput({ copilotState: "blocked_needs_user_decision" }));
  assert.equal(result.outerAction, "stop");
  assert.equal(result.stopReason, STOP_REASON.COPILOT_BLOCKED);
});

test("result.outerAction is 'stop' and stopReason=unknown_state for needs_reconcile fallback", () => {
  const result = evaluateConductorRouting(makeInput({ copilotState: "completely_unknown" }));
  assert.equal(result.outerAction, "stop");
  assert.equal(result.stopReason, STOP_REASON.UNKNOWN_STATE);
});

test("result.outerAction is 'continue_wait' for stay_with_current_live_owner", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "unresolved_feedback_present",
    reviewerState: "waiting_for_author_followup",
    ownershipState: "live_owner",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.STAY_WITH_CURRENT_LIVE_OWNER);
  assert.equal(result.outerAction, "continue_wait");
});

// ---------------------------------------------------------------------------
// requiresLocalIsolation passthrough
// ---------------------------------------------------------------------------

test("requiresLocalIsolation=true is propagated to handoff envelope for non-stop outcomes", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "already_fixed_needs_reply_resolve",
    reviewerState: "waiting_for_author_followup",
    requiresLocalIsolation: true,
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
  assert.equal(result.handoffEnvelope.requiresLocalIsolation, true);
});

test("requiresLocalIsolation defaults to false when not provided", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.handoffEnvelope.requiresLocalIsolation, false);
});

// ---------------------------------------------------------------------------
// Source mode / confidence passthrough
// ---------------------------------------------------------------------------

test("sourceMode=authoritative → confidence=authoritative in envelope", () => {
  const result = evaluateConductorRouting(makeInput({
    sourceMode: "authoritative",
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.handoffEnvelope.confidence, SOURCE_MODE.AUTHORITATIVE);
});

test("sourceMode=snapshot → confidence=snapshot in envelope", () => {
  const result = evaluateConductorRouting(makeInput({
    sourceMode: "snapshot",
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.handoffEnvelope.confidence, SOURCE_MODE.SNAPSHOT);
});

test("sourceMode defaults to local when not provided", () => {
  const result = evaluateConductorRouting(makeInput({
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.handoffEnvelope.confidence, SOURCE_MODE.LOCAL);
});

// ---------------------------------------------------------------------------
// Target identity normalization
// ---------------------------------------------------------------------------

test("target repo is normalized to lowercase in handoff envelope", () => {
  const result = evaluateConductorRouting(makeInput({
    target: { repo: "ACME/My-Repo", pr: 7 },
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.CONTINUE_CURRENT_WAIT);
  assert.equal(result.handoffEnvelope.targetIdentity.repo, "acme/my-repo");
  assert.equal(result.handoffEnvelope.requiredArgs.repo, "acme/my-repo");
});

// ---------------------------------------------------------------------------
// Ownership state: non-duplicate values do not block routing
// ---------------------------------------------------------------------------

test("ownershipState=no_record does not block routing", () => {
  const result = evaluateConductorRouting(makeInput({
    ownershipState: "no_record",
    copilotState: "pr_draft",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
});

test("ownershipState=watcher_only does not block routing", () => {
  const result = evaluateConductorRouting(makeInput({
    ownershipState: "watcher_only",
    copilotState: "unresolved_feedback_present",
    reviewerState: "waiting_for_review_request",
  }));
  assert.equal(result.routingOutcome, ROUTING_OUTCOME.HANDOFF_TO_COPILOT_LOOP);
});
