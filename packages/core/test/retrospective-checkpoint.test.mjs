import assert from "node:assert/strict";
import test from "node:test";

import {
  RETROSPECTIVE_CHECKPOINT_STATE,
  RETROSPECTIVE_QUALIFYING_GATES,
  isQualifyingAsyncCompletion,
  evaluateRetrospectiveGate,
} from "../src/loop/retrospective-checkpoint.mjs";

import {
  DEV_LOOP_ACTOR,
  DEV_LOOP_AUTHORIZATION,
  DEV_LOOP_GATE,
  DEV_LOOP_PUBLIC_INTENT,
  DEV_LOOP_ROUTE_KIND,
  DEV_LOOP_STATUS,
  DEV_LOOP_TARGET_KIND,
  DEV_LOOP_TARGET_PREFERENCE,
  INTERNAL_DEV_LOOP_STRATEGY,
  evaluatePublicDevLoopRouting,
} from "../src/loop/public-dev-loop-routing.mjs";

// ---------------------------------------------------------------------------
// RETROSPECTIVE_CHECKPOINT_STATE constants
// ---------------------------------------------------------------------------

test("RETROSPECTIVE_CHECKPOINT_STATE exports all four required state values", () => {
  assert.equal(RETROSPECTIVE_CHECKPOINT_STATE.NONE, "none");
  assert.equal(RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE, "complete");
  assert.equal(RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED, "skipped");
  assert.equal(RETROSPECTIVE_CHECKPOINT_STATE.MISSING, "missing");
  assert.equal(Object.keys(RETROSPECTIVE_CHECKPOINT_STATE).length, 4);
});

test("RETROSPECTIVE_CHECKPOINT_STATE is frozen", () => {
  assert.ok(Object.isFrozen(RETROSPECTIVE_CHECKPOINT_STATE));
});

// ---------------------------------------------------------------------------
// RETROSPECTIVE_QUALIFYING_GATES constants
// ---------------------------------------------------------------------------

test("RETROSPECTIVE_QUALIFYING_GATES includes the two required GitHub-first gates", () => {
  assert.ok(RETROSPECTIVE_QUALIFYING_GATES.includes("copilot_pr_followup"));
  assert.ok(RETROSPECTIVE_QUALIFYING_GATES.includes("issue_intake"));
});

test("RETROSPECTIVE_QUALIFYING_GATES is frozen", () => {
  assert.ok(Object.isFrozen(RETROSPECTIVE_QUALIFYING_GATES));
});

test("RETROSPECTIVE_QUALIFYING_GATES aligns with actual DEV_LOOP_GATE values", () => {
  for (const gate of RETROSPECTIVE_QUALIFYING_GATES) {
    assert.ok(
      Object.values(DEV_LOOP_GATE).includes(gate),
      `qualifying gate "${gate}" must be a valid DEV_LOOP_GATE value`,
    );
  }
});

// ---------------------------------------------------------------------------
// isQualifyingAsyncCompletion — classification
// ---------------------------------------------------------------------------

test("isQualifyingAsyncCompletion: routed GitHub-first copilot_pr_followup completion qualifies", () => {
  // This is the primary routed GitHub-first async path.
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.ok(
    isQualifyingAsyncCompletion(result),
    "copilot_pr_followup route must be classified as a qualifying async completion",
  );
});

test("isQualifyingAsyncCompletion: routed GitHub-first issue_intake completion qualifies", () => {
  // Issue intake is also a qualifying GitHub-first path (Copilot assignment flow).
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 112 },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.ISSUE_INTAKE);
  assert.ok(
    isQualifyingAsyncCompletion(result),
    "issue_intake route must be classified as a qualifying async completion",
  );
});

test("isQualifyingAsyncCompletion: local_implementation route does not qualify", () => {
  // Local implementation runs are not async GitHub-first completions.
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ISSUE_LOCALLY,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.LOCAL_IMPLEMENTATION);
  assert.equal(isQualifyingAsyncCompletion(result), false);
});

test("isQualifyingAsyncCompletion: wait/watch route does not qualify (not a completion)", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(isQualifyingAsyncCompletion(result), false);
});

test("isQualifyingAsyncCompletion: inspect route does not qualify", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);
  assert.equal(isQualifyingAsyncCompletion(result), false);
});

test("isQualifyingAsyncCompletion: stop result does not qualify", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.BLOCKED,
      authorization: DEV_LOOP_AUTHORIZATION.NOT_AUTHORIZED,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.STOP);
  assert.equal(isQualifyingAsyncCompletion(result), false);
});

test("isQualifyingAsyncCompletion: needs_reconcile result does not qualify", () => {
  // Invalid inputs produce needs_reconcile, which is not a qualifying completion.
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    // Missing required currentState — produces needs_reconcile
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(isQualifyingAsyncCompletion(result), false);
});

test("isQualifyingAsyncCompletion: returns false for null and non-object inputs", () => {
  assert.equal(isQualifyingAsyncCompletion(null), false);
  assert.equal(isQualifyingAsyncCompletion(undefined), false);
  assert.equal(isQualifyingAsyncCompletion("route"), false);
  assert.equal(isQualifyingAsyncCompletion(42), false);
});

// ---------------------------------------------------------------------------
// evaluateRetrospectiveGate — enforcement
// ---------------------------------------------------------------------------

// Build a minimal valid copilot_pr_followup routing result for gate tests.
function makeCopilotPrFollowupResult() {
  return evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });
}

// ── Retrospective satisfied: checkpoint COMPLETE ─────────────────────────────

test("evaluateRetrospectiveGate: COMPLETE checkpoint passes through the proposed routing unchanged", () => {
  const proposed = makeCopilotPrFollowupResult();
  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE,
    proposedRouting: proposed,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  assert.deepEqual(result, proposed);
});

// ── Explicit skip with reason ─────────────────────────────────────────────────

test("evaluateRetrospectiveGate: SKIPPED checkpoint passes through the proposed routing unchanged", () => {
  const proposed = makeCopilotPrFollowupResult();
  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED,
    proposedRouting: proposed,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.deepEqual(result, proposed);
});

// ── No qualifying completion ──────────────────────────────────────────────────

test("evaluateRetrospectiveGate: NONE checkpoint passes through the proposed routing unchanged", () => {
  const proposed = makeCopilotPrFollowupResult();
  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.NONE,
    proposedRouting: proposed,
  });

  assert.deepEqual(result, proposed);
});

// ── Missing retrospective checkpoint: fails closed on start/resume ────────────

test("evaluateRetrospectiveGate: MISSING checkpoint blocks a copilot_pr_followup start/resume and fails closed", () => {
  const proposed = makeCopilotPrFollowupResult();
  assert.equal(proposed.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);

  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    proposedRouting: proposed,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedGate, "fail_closed_reconcile");
  assert.equal(result.selectedStrategy, null);
  assert.match(result.nextAction, /retrospective/i);
  assert.match(result.reason, /missing/i);
});

test("evaluateRetrospectiveGate: MISSING checkpoint blocks an issue_intake start and fails closed", () => {
  const proposed = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 112 },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });
  assert.equal(proposed.selectedGate, DEV_LOOP_GATE.ISSUE_INTAKE);

  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    proposedRouting: proposed,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedGate, "fail_closed_reconcile");
  assert.match(result.nextAction, /retrospective/i);
});

// ── Pass-through for terminal results ────────────────────────────────────────

test("evaluateRetrospectiveGate: stop result passes through regardless of MISSING checkpoint", () => {
  const proposed = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.DONE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });
  assert.equal(proposed.routeKind, DEV_LOOP_ROUTE_KIND.STOP);

  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    proposedRouting: proposed,
  });

  assert.deepEqual(result, proposed);
});

test("evaluateRetrospectiveGate: needs_reconcile result passes through regardless of MISSING checkpoint", () => {
  const proposed = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    // Missing currentState — produces needs_reconcile
  });
  assert.equal(proposed.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);

  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    proposedRouting: proposed,
  });

  assert.deepEqual(result, proposed);
});

test("evaluateRetrospectiveGate: inspect result passes through regardless of MISSING checkpoint", () => {
  const proposed = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
  });
  assert.equal(proposed.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);

  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    proposedRouting: proposed,
  });

  assert.deepEqual(result, proposed);
});

// ── Unrecognized checkpoint state ─────────────────────────────────────────────

test("evaluateRetrospectiveGate: unrecognized checkpoint state fails closed", () => {
  const proposed = makeCopilotPrFollowupResult();
  const result = evaluateRetrospectiveGate({
    checkpointState: "unknown_state",
    proposedRouting: proposed,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedGate, "fail_closed_reconcile");
  assert.match(result.reason, /unrecognized/i);
});

// ── Missing or invalid proposedRouting ────────────────────────────────────────

test("evaluateRetrospectiveGate: null proposedRouting returns a fail-closed reconcile result", () => {
  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.NONE,
    proposedRouting: null,
  });

  assert.equal(result.routeKind, "needs_reconcile");
  assert.equal(result.selectedGate, "fail_closed_reconcile");
});

test("evaluateRetrospectiveGate: fail-closed reconcile result keeps stable routing-shape defaults", () => {
  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.NONE,
    proposedRouting: null,
  });

  assert.equal(result.executionMode, "bounded_handoff");
  assert.equal(result.waitSemantics, "default");
  assert.equal(result.issueAssignmentSeam, "not_applicable");
});

test("evaluateRetrospectiveGate: called with no arguments returns a fail-closed reconcile result", () => {
  const result = evaluateRetrospectiveGate();
  assert.equal(result.routeKind, "needs_reconcile");
});
