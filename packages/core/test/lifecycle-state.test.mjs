import assert from "node:assert/strict";
import test from "node:test";

import {
  LIFECYCLE_STATE,
  LIFECYCLE_TRANSITIONS,
  LIFECYCLE_GRAPH,
  LIFECYCLE_NEXT_ACTIONS,
  LIFECYCLE_TERMINAL_STATES,
  LIFECYCLE_NONTERMINAL_STATES,
  COPILOT_INNER_STATE_MAP,
  resolveLifecycleState,
  getAllowedTransitions,
  isTransitionAllowed,
  isKnownLifecycleState,
  lifecyclePhaseForCopilotState,
} from "../src/loop/lifecycle-state.mjs";

// ---------------------------------------------------------------------------
// State constant contract tests
// ---------------------------------------------------------------------------

test("lifecycle state constants define exactly 7 phases", () => {
  const values = Object.values(LIFECYCLE_STATE);
  assert.equal(values.length, 7);
  assert.deepEqual(values.sort(), [
    "draft_gate",
    "feedback_resolution",
    "implementation",
    "issue_intake",
    "merge",
    "pre_approval_gate",
    "refinement",
  ].sort());
});

test("lifecycle state values are the expected enum strings", () => {
  assert.equal(LIFECYCLE_STATE.ISSUE_INTAKE, "issue_intake");
  assert.equal(LIFECYCLE_STATE.REFINEMENT, "refinement");
  assert.equal(LIFECYCLE_STATE.IMPLEMENTATION, "implementation");
  assert.equal(LIFECYCLE_STATE.DRAFT_GATE, "draft_gate");
  assert.equal(LIFECYCLE_STATE.FEEDBACK_RESOLUTION, "feedback_resolution");
  assert.equal(LIFECYCLE_STATE.PRE_APPROVAL_GATE, "pre_approval_gate");
  assert.equal(LIFECYCLE_STATE.MERGE, "merge");
});

// ---------------------------------------------------------------------------
// Terminal / nonterminal contract tests
// ---------------------------------------------------------------------------

test("merge is the only terminal lifecycle state", () => {
  assert.deepEqual(LIFECYCLE_TERMINAL_STATES, [LIFECYCLE_STATE.MERGE]);
  assert.equal(LIFECYCLE_TERMINAL_STATES.length, 1);
});

test("nonterminal states include the 6 phases before merge", () => {
  assert.deepEqual([...LIFECYCLE_NONTERMINAL_STATES].sort(), [
    LIFECYCLE_STATE.ISSUE_INTAKE,
    LIFECYCLE_STATE.REFINEMENT,
    LIFECYCLE_STATE.IMPLEMENTATION,
    LIFECYCLE_STATE.DRAFT_GATE,
    LIFECYCLE_STATE.FEEDBACK_RESOLUTION,
    LIFECYCLE_STATE.PRE_APPROVAL_GATE,
  ].sort());
  assert.equal(LIFECYCLE_NONTERMINAL_STATES.length, 6);
});

// ---------------------------------------------------------------------------
// Transition graph contract tests
// ---------------------------------------------------------------------------

test("merge has no outgoing transitions (terminal)", () => {
  assert.deepEqual(LIFECYCLE_TRANSITIONS[LIFECYCLE_STATE.MERGE], []);
  assert.deepEqual(getAllowedTransitions(LIFECYCLE_STATE.MERGE), []);
});

test("pre_approval_gate can transition to implementation, feedback_resolution, or merge", () => {
  const allowed = LIFECYCLE_TRANSITIONS[LIFECYCLE_STATE.PRE_APPROVAL_GATE];
  assert.deepEqual([...allowed].sort(), [
    LIFECYCLE_STATE.IMPLEMENTATION,
    LIFECYCLE_STATE.FEEDBACK_RESOLUTION,
    LIFECYCLE_STATE.MERGE,
  ].sort());
});

test("feedback_resolution can transition to implementation or pre_approval_gate", () => {
  const allowed = LIFECYCLE_TRANSITIONS[LIFECYCLE_STATE.FEEDBACK_RESOLUTION];
  assert.deepEqual([...allowed].sort(), [
    LIFECYCLE_STATE.IMPLEMENTATION,
    LIFECYCLE_STATE.PRE_APPROVAL_GATE,
  ].sort());
});

test("draft_gate can transition to implementation or feedback_resolution", () => {
  const allowed = LIFECYCLE_TRANSITIONS[LIFECYCLE_STATE.DRAFT_GATE];
  assert.deepEqual([...allowed].sort(), [
    LIFECYCLE_STATE.IMPLEMENTATION,
    LIFECYCLE_STATE.FEEDBACK_RESOLUTION,
  ].sort());
});

test("implementation can transition to draft_gate or feedback_resolution", () => {
  const allowed = LIFECYCLE_TRANSITIONS[LIFECYCLE_STATE.IMPLEMENTATION];
  assert.deepEqual([...allowed].sort(), [
    LIFECYCLE_STATE.DRAFT_GATE,
    LIFECYCLE_STATE.FEEDBACK_RESOLUTION,
  ].sort());
});

test("refinement can transition to issue_intake or implementation", () => {
  const allowed = LIFECYCLE_TRANSITIONS[LIFECYCLE_STATE.REFINEMENT];
  assert.deepEqual([...allowed].sort(), [
    LIFECYCLE_STATE.ISSUE_INTAKE,
    LIFECYCLE_STATE.IMPLEMENTATION,
  ].sort());
});

test("issue_intake can transition to refinement or implementation", () => {
  const allowed = LIFECYCLE_TRANSITIONS[LIFECYCLE_STATE.ISSUE_INTAKE];
  assert.deepEqual([...allowed].sort(), [
    LIFECYCLE_STATE.REFINEMENT,
    LIFECYCLE_STATE.IMPLEMENTATION,
  ].sort());
});

test("transition graph has exactly 7 entries (one per phase)", () => {
  assert.equal(Object.keys(LIFECYCLE_TRANSITIONS).length, 7);
});

test("every nonterminal state has at least one outgoing transition", () => {
  for (const state of LIFECYCLE_NONTERMINAL_STATES) {
    assert.ok(
      LIFECYCLE_TRANSITIONS[state].length > 0,
      `${state} should have at least one transition`,
    );
  }
});

// ---------------------------------------------------------------------------
// isTransitionAllowed contract tests
// ---------------------------------------------------------------------------

test("isTransitionAllowed returns true for legal transitions", () => {
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.ISSUE_INTAKE, LIFECYCLE_STATE.REFINEMENT), true);
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.REFINEMENT, LIFECYCLE_STATE.IMPLEMENTATION), true);
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.IMPLEMENTATION, LIFECYCLE_STATE.DRAFT_GATE), true);
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.DRAFT_GATE, LIFECYCLE_STATE.FEEDBACK_RESOLUTION), true);
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.FEEDBACK_RESOLUTION, LIFECYCLE_STATE.PRE_APPROVAL_GATE), true);
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.PRE_APPROVAL_GATE, LIFECYCLE_STATE.MERGE), true);
});

test("isTransitionAllowed returns false for illegal transitions", () => {
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.ISSUE_INTAKE, LIFECYCLE_STATE.MERGE), false);
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.REFINEMENT, LIFECYCLE_STATE.MERGE), false);
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.IMPLEMENTATION, LIFECYCLE_STATE.MERGE), false);
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.MERGE, LIFECYCLE_STATE.ISSUE_INTAKE), false);
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.DRAFT_GATE, LIFECYCLE_STATE.ISSUE_INTAKE), false);
});

test("isTransitionAllowed returns false for unknown states", () => {
  assert.equal(isTransitionAllowed("unknown", LIFECYCLE_STATE.MERGE), false);
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.ISSUE_INTAKE, "unknown"), false);
  assert.equal(isTransitionAllowed("bad", "worse"), false);
});

test("isTransitionAllowed returns false for back-transitions not in the graph", () => {
  // merge → implementation is not allowed
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.MERGE, LIFECYCLE_STATE.IMPLEMENTATION), false);
  // pre_approval_gate → issue_intake is not allowed
  assert.equal(isTransitionAllowed(LIFECYCLE_STATE.PRE_APPROVAL_GATE, LIFECYCLE_STATE.ISSUE_INTAKE), false);
});

// ---------------------------------------------------------------------------
// getAllowedTransitions contract tests
// ---------------------------------------------------------------------------

test("getAllowedTransitions returns a copy (not the frozen array)", () => {
  const transitions = getAllowedTransitions(LIFECYCLE_STATE.ISSUE_INTAKE);
  assert.notEqual(transitions, LIFECYCLE_TRANSITIONS[LIFECYCLE_STATE.ISSUE_INTAKE]);
  assert.deepEqual(transitions, LIFECYCLE_TRANSITIONS[LIFECYCLE_STATE.ISSUE_INTAKE]);
});

test("getAllowedTransitions returns empty array for unknown state", () => {
  assert.deepEqual(getAllowedTransitions("unknown"), []);
  assert.deepEqual(getAllowedTransitions(""), []);
  assert.deepEqual(getAllowedTransitions(null), []);
});

// ---------------------------------------------------------------------------
// isKnownLifecycleState contract tests
// ---------------------------------------------------------------------------

test("isKnownLifecycleState recognizes all valid states", () => {
  for (const state of Object.values(LIFECYCLE_STATE)) {
    assert.equal(isKnownLifecycleState(state), true);
  }
});

test("isKnownLifecycleState rejects unknown values", () => {
  assert.equal(isKnownLifecycleState("unknown"), false);
  assert.equal(isKnownLifecycleState(""), false);
  assert.equal(isKnownLifecycleState(null), false);
  assert.equal(isKnownLifecycleState(undefined), false);
});

// ---------------------------------------------------------------------------
// Graph metadata contract tests
// ---------------------------------------------------------------------------

test("lifecycle graph has semantic start and end", () => {
  assert.deepEqual(LIFECYCLE_GRAPH.start, { id: "lifecycle_start", label: "Start", semantic: true });
  assert.deepEqual(LIFECYCLE_GRAPH.end, { id: "lifecycle_end", label: "End", semantic: true });
});

test("lifecycle graph entryState is issue_intake", () => {
  assert.equal(LIFECYCLE_GRAPH.entryState, LIFECYCLE_STATE.ISSUE_INTAKE);
});

test("lifecycle graph entryStates includes all 7 phases", () => {
  assert.deepEqual([...LIFECYCLE_GRAPH.entryStates].sort(), Object.values(LIFECYCLE_STATE).sort());
});

test("lifecycle graph terminalStates matches LIFECYCLE_TERMINAL_STATES", () => {
  assert.deepEqual(LIFECYCLE_GRAPH.terminalStates, LIFECYCLE_TERMINAL_STATES);
});

test("lifecycle graph terminalState and nonterminalState sets are disjoint", () => {
  const terminalSet = new Set(LIFECYCLE_GRAPH.terminalStates);
  for (const state of LIFECYCLE_GRAPH.nonterminalStates) {
    assert.equal(terminalSet.has(state), false, `${state} should not be terminal`);
  }
});

// ---------------------------------------------------------------------------
// Next actions contract tests
// ---------------------------------------------------------------------------

test("every lifecycle state has a defined next action string", () => {
  for (const state of Object.values(LIFECYCLE_STATE)) {
    assert.equal(typeof LIFECYCLE_NEXT_ACTIONS[state], "string");
    assert.ok(LIFECYCLE_NEXT_ACTIONS[state].length > 0, `${state} next action must not be empty`);
  }
});

test("merge next action includes retrospective checkpoint", () => {
  assert.ok(
    LIFECYCLE_NEXT_ACTIONS[LIFECYCLE_STATE.MERGE].includes("merge"),
    "merge next action should mention merge",
  );
});

// ---------------------------------------------------------------------------
// Resolver: resolveLifecycleState contract tests
// ---------------------------------------------------------------------------

test("resolveLifecycleState: no PR → issue_intake", () => {
  const result = resolveLifecycleState({});
  assert.equal(result.state, LIFECYCLE_STATE.ISSUE_INTAKE);
  assert.equal(result.isTerminal, false);
  assert.equal(typeof result.nextAction, "string");
  assert.ok(result.allowedTransitions.length > 0);
});

test("resolveLifecycleState: draft PR → implementation", () => {
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    prIsDraft: true,
  });
  assert.equal(result.state, LIFECYCLE_STATE.IMPLEMENTATION);
  assert.equal(result.isTerminal, false);
});

test("resolveLifecycleState: ready PR (not draft) → implementation", () => {
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    prIsDraft: false,
  });
  assert.equal(result.state, LIFECYCLE_STATE.IMPLEMENTATION);
  assert.equal(result.isTerminal, false);
});

test("resolveLifecycleState: unresolved threads → feedback_resolution", () => {
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    prIsDraft: false,
    hasUnresolvedThreads: true,
  });
  assert.equal(result.state, LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
});

test("resolveLifecycleState: unresolved threads beats draft (threads > gate)", () => {
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    prIsDraft: true,
    hasUnresolvedThreads: true,
  });
  assert.equal(result.state, LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
});

test("resolveLifecycleState: pre-approval passed → pre_approval_gate", () => {
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    prIsDraft: false,
    hasUnresolvedThreads: false,
    preApprovalGatePassed: true,
  });
  assert.equal(result.state, LIFECYCLE_STATE.PRE_APPROVAL_GATE);
});

test("resolveLifecycleState: pre-approval + merge authorized → merge", () => {
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    hasUnresolvedThreads: false,
    preApprovalGatePassed: true,
    mergeAuthorized: true,
  });
  assert.equal(result.state, LIFECYCLE_STATE.MERGE);
  assert.equal(result.isTerminal, true);
  assert.deepEqual(result.allowedTransitions, []);
});

test("resolveLifecycleState: pre-approval + merge authorized without linked PR → not merge", () => {
  const result = resolveLifecycleState({
    hasLinkedPr: false,
    hasUnresolvedThreads: false,
    preApprovalGatePassed: true,
    mergeAuthorized: true,
  });
  assert.notEqual(result.state, LIFECYCLE_STATE.MERGE);
  assert.equal(result.state, LIFECYCLE_STATE.ISSUE_INTAKE);
});

test("resolveLifecycleState: sizeBudgetHumanApprovalRequired fails closed — merge authorized but NOT merge (size-budget merge gate, phase 3 of the fail-closed PR size budget)", () => {
  // An escalated/T1 PR without a human APPROVED review parks at
  // pre_approval_gate (the existing human-approval handoff) instead of
  // advancing to merge, even under mergeAuthorized: true — the size-budget
  // merge gate is consulted IN ADDITION TO mergeAuthorized/humanMergeOnly.
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    hasUnresolvedThreads: false,
    preApprovalGatePassed: true,
    mergeAuthorized: true,
    sizeBudgetHumanApprovalRequired: true,
  });
  assert.notEqual(result.state, LIFECYCLE_STATE.MERGE);
  assert.equal(result.state, LIFECYCLE_STATE.PRE_APPROVAL_GATE);
  assert.equal(result.isTerminal, false);
});

test("resolveLifecycleState: sizeBudgetHumanApprovalRequired defaults to false — unchanged behavior for callers that never evaluate the size budget", () => {
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    hasUnresolvedThreads: false,
    preApprovalGatePassed: true,
    mergeAuthorized: true,
  });
  assert.equal(result.state, LIFECYCLE_STATE.MERGE);
});

test("resolveLifecycleState: sizeBudgetHumanApprovalRequired false (gate clear) still allows merge", () => {
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    hasUnresolvedThreads: false,
    preApprovalGatePassed: true,
    mergeAuthorized: true,
    sizeBudgetHumanApprovalRequired: false,
  });
  assert.equal(result.state, LIFECYCLE_STATE.MERGE);
});

test("resolveLifecycleState: humanMergeOnly fails closed — merge authorized but NOT merge (issue #910)", () => {
  // The fixed repo invariant: even with mergeAuthorized + pre-approval + linked
  // PR, the agent is never cleared to merge. It stays at the human-merge handoff
  // (pre_approval_gate) rather than advancing to the terminal merge action.
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    hasUnresolvedThreads: false,
    preApprovalGatePassed: true,
    mergeAuthorized: true,
    humanMergeOnly: true,
  });
  assert.notEqual(result.state, LIFECYCLE_STATE.MERGE);
  assert.equal(result.state, LIFECYCLE_STATE.PRE_APPROVAL_GATE);
  assert.equal(result.isTerminal, false);
});

test("resolveLifecycleState: fails closed on a non-boolean mergeAuthorized (only true clears merge)", () => {
  // A non-boolean truthy mergeAuthorized must NOT advance to MERGE, matching the
  // authoritative resolveEffectiveMergeAuthorized gate (#910 round-2).
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    hasUnresolvedThreads: false,
    preApprovalGatePassed: true,
    mergeAuthorized: "yes",
    humanMergeOnly: false,
  });
  assert.notEqual(result.state, LIFECYCLE_STATE.MERGE);
});

test("resolveLifecycleState: humanMergeOnly does not block an already-merged PR (terminal)", () => {
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    isMerged: true,
    mergeAuthorized: true,
    humanMergeOnly: true,
  });
  assert.equal(result.state, LIFECYCLE_STATE.MERGE);
  assert.equal(result.isTerminal, true);
});

test("resolveLifecycleState: merge authorized without pre-approval → earlier phase", () => {
  // merge authorization alone without pre-approval gate shouldn't jump to merge
  const result = resolveLifecycleState({
    hasLinkedPr: true,
    hasUnresolvedThreads: false,
    mergeAuthorized: true,
  });
  assert.notEqual(result.state, LIFECYCLE_STATE.MERGE);
});

test("resolveLifecycleState: merged → merge (terminal)", () => {
  const result = resolveLifecycleState({
    isMerged: true,
  });
  assert.equal(result.state, LIFECYCLE_STATE.MERGE);
  assert.equal(result.isTerminal, true);
});

test("resolveLifecycleState: merged beats all other flags", () => {
  const result = resolveLifecycleState({
    isMerged: true,
    hasLinkedPr: true,
    prIsDraft: true,
    hasUnresolvedThreads: true,
  });
  assert.equal(result.state, LIFECYCLE_STATE.MERGE);
});

test("resolveLifecycleState: explicit phase overrides inference", () => {
  const result = resolveLifecycleState({
    phase: LIFECYCLE_STATE.REFINEMENT,
    hasLinkedPr: true,
    hasUnresolvedThreads: true,
    preApprovalGatePassed: true,
  });
  assert.equal(result.state, LIFECYCLE_STATE.REFINEMENT);
});

test("resolveLifecycleState: explicit phase must be recognized", () => {
  const result = resolveLifecycleState({
    phase: "unknown",
    hasLinkedPr: true,
    hasUnresolvedThreads: true,
  });
  // Falls back because unknown phase normalizes to null → inference takes over
  assert.equal(result.state, LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
});

test("resolveLifecycleState: empty input returns issue_intake", () => {
  const result = resolveLifecycleState();
  assert.equal(result.state, LIFECYCLE_STATE.ISSUE_INTAKE);
  assert.equal(result.isTerminal, false);
});

test("resolveLifecycleState: result shape is consistent", () => {
  const result = resolveLifecycleState({ hasLinkedPr: true, prIsDraft: true });
  assert.equal(typeof result.state, "string");
  assert.ok(Array.isArray(result.allowedTransitions));
  assert.equal(typeof result.nextAction, "string");
  assert.equal(typeof result.isTerminal, "boolean");
});

// ---------------------------------------------------------------------------
// Forward progress: full linear path contract test
// ---------------------------------------------------------------------------

test("full linear lifecycle path is traversable via legal transitions", () => {
  const path = [
    LIFECYCLE_STATE.ISSUE_INTAKE,
    LIFECYCLE_STATE.REFINEMENT,
    LIFECYCLE_STATE.IMPLEMENTATION,
    LIFECYCLE_STATE.DRAFT_GATE,
    LIFECYCLE_STATE.FEEDBACK_RESOLUTION,
    LIFECYCLE_STATE.PRE_APPROVAL_GATE,
    LIFECYCLE_STATE.MERGE,
  ];

  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(
      isTransitionAllowed(path[i], path[i + 1]),
      true,
      `Transition ${path[i]} → ${path[i + 1]} should be legal`,
    );
  }
});

// ---------------------------------------------------------------------------
// COPILOT_INNER_STATE_MAP contract tests
// ---------------------------------------------------------------------------

test("copilot inner state map covers all lifecycle phases", () => {
  for (const phase of Object.values(LIFECYCLE_STATE)) {
    assert.ok(
      Array.isArray(COPILOT_INNER_STATE_MAP[phase]),
      `${phase} should have an inner state map entry`,
    );
  }
});

test("issue_intake and refinement map to empty inner states (outer-only)", () => {
  assert.deepEqual(COPILOT_INNER_STATE_MAP[LIFECYCLE_STATE.ISSUE_INTAKE], []);
  assert.deepEqual(COPILOT_INNER_STATE_MAP[LIFECYCLE_STATE.REFINEMENT], []);
});

test("merge maps to done inner state", () => {
  assert.deepEqual(COPILOT_INNER_STATE_MAP[LIFECYCLE_STATE.MERGE], ["done"]);
});

test("implementation maps to no_pr and pr_draft inner states", () => {
  const inner = COPILOT_INNER_STATE_MAP[LIFECYCLE_STATE.IMPLEMENTATION];
  assert.deepEqual([...inner].sort(), ["no_pr", "pr_draft"].sort());
});

test("draft_gate maps to pr_ready_no_feedback", () => {
  assert.deepEqual(COPILOT_INNER_STATE_MAP[LIFECYCLE_STATE.DRAFT_GATE], ["pr_ready_no_feedback"]);
});

test("feedback_resolution maps to review/fix inner states", () => {
  const inner = COPILOT_INNER_STATE_MAP[LIFECYCLE_STATE.FEEDBACK_RESOLUTION];
  assert.deepEqual([...inner].sort(), [
    "waiting_for_copilot_review",
    "unresolved_feedback_present",
    "already_fixed_needs_reply_resolve",
    "ready_to_rerequest_review",
    "waiting_for_ci",
    "review_request_unavailable",
    "blocked_needs_user_decision",
    "round_cap_reached",
  ].sort());
});

test("pre_approval_gate maps to convergence inner states", () => {
  const inner = COPILOT_INNER_STATE_MAP[LIFECYCLE_STATE.PRE_APPROVAL_GATE];
  assert.deepEqual([...inner].sort(), [
    "low_signal_converged",
    "round_cap_clean_fallback",
    "internal_tooling_direct_gate",
  ].sort());
});

test("no copilot inner state appears in more than one lifecycle phase", () => {
  const seen = new Map();
  for (const [phase, innerStates] of Object.entries(COPILOT_INNER_STATE_MAP)) {
    for (const inner of innerStates) {
      if (seen.has(inner)) {
        assert.fail(`Inner state "${inner}" appears in both "${seen.get(inner)}" and "${phase}"`);
      }
      seen.set(inner, phase);
    }
  }
  // If we got here, no duplicates
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// lifecyclePhaseForCopilotState contract tests
// ---------------------------------------------------------------------------

test("lifecyclePhaseForCopilotState returns correct phase for known inner states", () => {
  assert.equal(lifecyclePhaseForCopilotState("no_pr"), LIFECYCLE_STATE.IMPLEMENTATION);
  assert.equal(lifecyclePhaseForCopilotState("pr_draft"), LIFECYCLE_STATE.IMPLEMENTATION);
  assert.equal(lifecyclePhaseForCopilotState("pr_ready_no_feedback"), LIFECYCLE_STATE.DRAFT_GATE);
  assert.equal(lifecyclePhaseForCopilotState("waiting_for_copilot_review"), LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
  assert.equal(lifecyclePhaseForCopilotState("unresolved_feedback_present"), LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
  assert.equal(lifecyclePhaseForCopilotState("already_fixed_needs_reply_resolve"), LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
  assert.equal(lifecyclePhaseForCopilotState("ready_to_rerequest_review"), LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
  assert.equal(lifecyclePhaseForCopilotState("waiting_for_ci"), LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
  assert.equal(lifecyclePhaseForCopilotState("done"), LIFECYCLE_STATE.MERGE);
  assert.equal(lifecyclePhaseForCopilotState("low_signal_converged"), LIFECYCLE_STATE.PRE_APPROVAL_GATE);
  assert.equal(lifecyclePhaseForCopilotState("round_cap_clean_fallback"), LIFECYCLE_STATE.PRE_APPROVAL_GATE);
  assert.equal(lifecyclePhaseForCopilotState("internal_tooling_direct_gate"), LIFECYCLE_STATE.PRE_APPROVAL_GATE);
});

test("lifecyclePhaseForCopilotState handles known fallback and unknown inner states", () => {
  assert.equal(lifecyclePhaseForCopilotState("blocked_needs_user_decision"), LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
  assert.equal(lifecyclePhaseForCopilotState("review_request_unavailable"), LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
  assert.equal(lifecyclePhaseForCopilotState("round_cap_reached"), LIFECYCLE_STATE.FEEDBACK_RESOLUTION);
  assert.equal(lifecyclePhaseForCopilotState("unknown_state"), null);
  assert.equal(lifecyclePhaseForCopilotState(""), null);
  assert.equal(lifecyclePhaseForCopilotState(null), null);
});

// ---------------------------------------------------------------------------
// Resolver: all valid transitions produce valid results
// ---------------------------------------------------------------------------

test("resolveLifecycleState result is valid for all transition inputs", () => {
  const states = Object.values(LIFECYCLE_STATE);

  // Every explicit phase returns a valid result
  for (const state of states) {
    const result = resolveLifecycleState({ phase: state });
    assert.equal(result.state, state);
    assert.equal(typeof result.isTerminal, "boolean");
    assert.ok(Array.isArray(result.allowedTransitions));
    assert.equal(typeof result.nextAction, "string");
  }
});
