import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPOSITION,
  STATE,
  TRANSITIONS,
  normalizeSnapshot,
  interpretLoopState,
  applyConfirmedReviewRequest,
  summarizeLoopInterpretation,
  isCopilotRoundCapReached,
  toSharedRequestStatus,
} from "../src/loop/copilot-loop-state.mjs";

// ---------------------------------------------------------------------------
// normalizeSnapshot
// ---------------------------------------------------------------------------

test("normalizeSnapshot rejects non-object input", () => {
  assert.throws(() => normalizeSnapshot(null), /Snapshot must be a non-null object/);
  assert.throws(() => normalizeSnapshot(undefined), /Snapshot must be a non-null object/);
  assert.throws(() => normalizeSnapshot("string"), /Snapshot must be a non-null object/);
  assert.throws(() => normalizeSnapshot(42), /Snapshot must be a non-null object/);
});

test("normalizeSnapshot returns safe defaults for an empty object", () => {
  const result = normalizeSnapshot({});
  assert.deepEqual(result, {
    prExists: false,
    prNumber: null,
    prDraft: false,
    prMerged: false,
    prClosed: false,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: false,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 0,
    ciStatus: "none",
    lastCopilotRoundMaxSignal: null,
    agentFixStatus: null,
    failureDetails: [],
    excludedFailureDetails: [],
  });
});

test("normalizeSnapshot coerces boolean-like fields", () => {
  const result = normalizeSnapshot({
    prExists: 1,
    prDraft: "yes",
    prMerged: 0,
    prClosed: "",
    copilotReviewPresent: "true",
  });
  assert.equal(result.prExists, true);
  assert.equal(result.prDraft, true);
  assert.equal(result.prMerged, false);
  assert.equal(result.prClosed, false);
  assert.equal(result.copilotReviewPresent, true);
});

test("normalizeSnapshot normalizes prNumber only when prExists is true", () => {
  const withPr = normalizeSnapshot({ prExists: true, prNumber: 17 });
  assert.equal(withPr.prNumber, 17);

  const withoutPr = normalizeSnapshot({ prExists: false, prNumber: 17 });
  assert.equal(withoutPr.prNumber, null);

  const invalidNumber = normalizeSnapshot({ prExists: true, prNumber: -5 });
  assert.equal(invalidNumber.prNumber, null);

  const zeroNumber = normalizeSnapshot({ prExists: true, prNumber: 0 });
  assert.equal(zeroNumber.prNumber, null);

  const floatNumber = normalizeSnapshot({ prExists: true, prNumber: 7.9 });
  assert.equal(floatNumber.prNumber, 7);
});

test("normalizeSnapshot accepts all valid copilotReviewRequestStatus values", () => {
  for (const status of ["requested", "already-requested", "unavailable", "none", "failed"]) {
    const result = normalizeSnapshot({ copilotReviewRequestStatus: status });
    assert.equal(result.copilotReviewRequestStatus, status, `expected ${status}`);
  }
});

test("normalizeSnapshot replaces unknown copilotReviewRequestStatus with none", () => {
  const result = normalizeSnapshot({ copilotReviewRequestStatus: "bogus" });
  assert.equal(result.copilotReviewRequestStatus, "none");
});

test("normalizeSnapshot floors fractional thread counts and rejects negatives", () => {
  const fractional = normalizeSnapshot({ unresolvedThreadCount: 2.9, actionableThreadCount: 1.1 });
  assert.equal(fractional.unresolvedThreadCount, 2);
  assert.equal(fractional.actionableThreadCount, 1);

  const negative = normalizeSnapshot({ unresolvedThreadCount: -1, actionableThreadCount: -2 });
  assert.equal(negative.unresolvedThreadCount, 0);
  assert.equal(negative.actionableThreadCount, 0);
});

test("normalizeSnapshot floors copilotReviewRoundCount and rejects negatives", () => {
  const fractional = normalizeSnapshot({ copilotReviewRoundCount: 3.9 });
  assert.equal(fractional.copilotReviewRoundCount, 3);

  const negative = normalizeSnapshot({ copilotReviewRoundCount: -1 });
  assert.equal(negative.copilotReviewRoundCount, 0);
});

test("normalizeSnapshot accepts all valid ciStatus values", () => {
  for (const status of ["success", "failure", "pending", "none", "crediblyGreen"]) {
    const result = normalizeSnapshot({ ciStatus: status });
    assert.equal(result.ciStatus, status, `expected ${status}`);
  }
});

test("normalizeSnapshot replaces unknown ciStatus with none", () => {
  const result = normalizeSnapshot({ ciStatus: "unknown" });
  assert.equal(result.ciStatus, "none");
});

test("normalizeSnapshot accepts agentFixStatus applied and defaults others to null", () => {
  const applied = normalizeSnapshot({ agentFixStatus: "applied" });
  assert.equal(applied.agentFixStatus, "applied");

  const other = normalizeSnapshot({ agentFixStatus: "pending" });
  assert.equal(other.agentFixStatus, null);

  const missing = normalizeSnapshot({});
  assert.equal(missing.agentFixStatus, null);
});

// ---------------------------------------------------------------------------
// TRANSITIONS graph completeness
// ---------------------------------------------------------------------------

test("TRANSITIONS covers every STATE value", () => {
  for (const stateName of Object.values(STATE)) {
    assert.ok(Object.prototype.hasOwnProperty.call(TRANSITIONS, stateName), `missing transition entry for ${stateName}`);
  }
});

test("TRANSITIONS only references valid STATE values", () => {
  const validStates = new Set(Object.values(STATE));
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    assert.ok(validStates.has(from), `unknown source state: ${from}`);
    for (const target of targets) {
      assert.ok(validStates.has(target), `unknown target state ${target} in transitions from ${from}`);
    }
  }
});

test("terminal states have empty transition arrays", () => {
  for (const terminal of [STATE.NO_PR, STATE.REVIEW_REQUEST_UNAVAILABLE, STATE.BLOCKED_NEEDS_USER_DECISION, STATE.DONE]) {
    assert.deepEqual(TRANSITIONS[terminal], [], `expected no transitions from ${terminal}`);
  }
});

// ---------------------------------------------------------------------------
// interpretLoopState — core routing
// ---------------------------------------------------------------------------

test("interpretLoopState returns no_pr when prExists is false", () => {
  const result = interpretLoopState({ prExists: false });
  assert.equal(result.state, STATE.NO_PR);
  assert.deepEqual(result.allowedTransitions, []);
  assert.ok(typeof result.nextAction === "string" && result.nextAction.length > 0);
});

test("interpretLoopState returns done for merged PR", () => {
  const result = interpretLoopState({ prExists: true, prNumber: 1, prMerged: true });
  assert.equal(result.state, STATE.DONE);
});

test("interpretLoopState returns done for closed PR", () => {
  const result = interpretLoopState({ prExists: true, prNumber: 1, prClosed: true });
  assert.equal(result.state, STATE.DONE);
});

test("interpretLoopState returns pr_draft for draft PR", () => {
  const result = interpretLoopState({ prExists: true, prNumber: 1, prDraft: true });
  assert.equal(result.state, STATE.PR_DRAFT);
  assert.deepEqual(result.allowedTransitions, [STATE.PR_READY_NO_FEEDBACK]);
});

test("interpretLoopState returns review_request_unavailable for unavailable status", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "unavailable",
  });
  assert.equal(result.state, STATE.REVIEW_REQUEST_UNAVAILABLE);
  assert.deepEqual(result.allowedTransitions, []);
  assert.match(result.nextAction, /stop/i);
});

test("interpretLoopState returns blocked_needs_user_decision for failed review request", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "failed",
  });
  assert.equal(result.state, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.deepEqual(result.allowedTransitions, []);
});

// ---------------------------------------------------------------------------
// Regression: unresolved feedback must route to fix/reply-resolve, never wait
// ---------------------------------------------------------------------------

test("interpretLoopState routes into unresolved_feedback_present when threads exist — not waiting", () => {
  // Regression: even if Copilot review was recently requested, unresolved threads take priority
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "already-requested",
    copilotReviewPresent: true,
    unresolvedThreadCount: 2,
    actionableThreadCount: 1,
  });
  assert.equal(result.state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
  assert.ok(result.allowedTransitions.includes(STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE));
  assert.ok(!result.allowedTransitions.includes(STATE.WAITING_FOR_COPILOT_REVIEW),
    "must not include waiting_for_copilot_review when unresolved threads exist");
});

// ---------------------------------------------------------------------------
// Pre-approval CI opt-out (#1337): the interpreter — the state selector the real
// gate-coordination path uses — must honor preApprovalRequireCi so a non-draft
// converged zero-CI/failing-CI PR is not dead-ended at WAITING_FOR_CI / BLOCKED
// before the (already flag-gated) downstream guards are reached.
// ---------------------------------------------------------------------------

const convergedZeroCiSnapshot = (ciStatus) => ({
  prExists: true,
  prNumber: 1337,
  prDraft: false,
  copilotReviewRequestStatus: "none",
  copilotReviewPresent: true,
  unresolvedThreadCount: 0,
  actionableThreadCount: 0,
  ciStatus,
});

test("interpretLoopState with preApprovalRequireCi:false routes zero-check CI (none) to ready, not waiting_for_ci", () => {
  const result = interpretLoopState(convergedZeroCiSnapshot("none"), { preApprovalRequireCi: false });
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.notEqual(result.state, STATE.WAITING_FOR_CI);
});

test("interpretLoopState default (no flag) still routes zero-check CI (none) to waiting_for_ci", () => {
  const result = interpretLoopState(convergedZeroCiSnapshot("none"));
  assert.equal(result.state, STATE.WAITING_FOR_CI);
});

test("interpretLoopState with preApprovalRequireCi:false ignores a real CI failure (not blocked)", () => {
  const result = interpretLoopState(convergedZeroCiSnapshot("failure"), { preApprovalRequireCi: false });
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.notEqual(result.state, STATE.BLOCKED_NEEDS_USER_DECISION);
});

test("interpretLoopState default (no flag) still blocks on a real CI failure", () => {
  const result = interpretLoopState(convergedZeroCiSnapshot("failure"));
  assert.equal(result.state, STATE.BLOCKED_NEEDS_USER_DECISION);
});

test("interpretLoopState routes into unresolved_feedback_present when threads exist regardless of request status", () => {
  for (const status of ["requested", "already-requested", "none"]) {
    const result = interpretLoopState({
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: status,
      copilotReviewPresent: true,
      unresolvedThreadCount: 3,
      actionableThreadCount: 2,
    });
    assert.equal(result.state, STATE.UNRESOLVED_FEEDBACK_PRESENT, `failed for status=${status}`);
  }
});

// ---------------------------------------------------------------------------
// Regression: already-fixed-but-unresolved requires reply/resolve before re-request
// ---------------------------------------------------------------------------

test("interpretLoopState routes to already_fixed_needs_reply_resolve when agentFixStatus is applied", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewPresent: true,
    unresolvedThreadCount: 2,
    actionableThreadCount: 2,
    agentFixStatus: "applied",
  });
  assert.equal(result.state, STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE);
  assert.deepEqual(result.allowedTransitions, [STATE.READY_TO_REREQUEST_REVIEW]);
  assert.ok(!result.allowedTransitions.includes(STATE.WAITING_FOR_COPILOT_REVIEW),
    "reply/resolve must complete before re-request becomes allowed");
  assert.match(result.nextAction, /reply/i);
});

test("interpretLoopState routes to already_fixed_needs_reply_resolve even with pending request when fix applied", () => {
  // Agent fixed code; re-request should NOT happen before reply/resolve
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    unresolvedThreadCount: 1,
    actionableThreadCount: 1,
    agentFixStatus: "applied",
  });
  assert.equal(result.state, STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE);
  assert.deepEqual(result.allowedTransitions, [STATE.READY_TO_REREQUEST_REVIEW]);
});

// ---------------------------------------------------------------------------
// Regression: unavailable/failed must stop/report, not sleep/watch
// ---------------------------------------------------------------------------

test("interpretLoopState does not enter wait states after unavailable review request", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "unavailable",
    copilotReviewPresent: false,
    unresolvedThreadCount: 0,
  });
  assert.equal(result.state, STATE.REVIEW_REQUEST_UNAVAILABLE);
  assert.notEqual(result.state, STATE.WAITING_FOR_COPILOT_REVIEW);
  assert.notEqual(result.state, STATE.WAITING_FOR_CI);
  assert.deepEqual(result.allowedTransitions, []);
});

test("interpretLoopState does not enter wait states after failed review request", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "failed",
    copilotReviewPresent: false,
    unresolvedThreadCount: 0,
  });
  assert.equal(result.state, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.notEqual(result.state, STATE.WAITING_FOR_COPILOT_REVIEW);
  assert.deepEqual(result.allowedTransitions, []);
});

// ---------------------------------------------------------------------------
// Normal flow states
// ---------------------------------------------------------------------------

test("interpretLoopState returns pr_ready_no_feedback for open ready PR with no review", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    prDraft: false,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: false,
    unresolvedThreadCount: 0,
    ciStatus: "success",
  });
  assert.equal(result.state, STATE.PR_READY_NO_FEEDBACK);
  assert.deepEqual(result.allowedTransitions, [STATE.WAITING_FOR_COPILOT_REVIEW]);
});

test("interpretLoopState returns waiting_for_ci for open PR with no review when ciStatus is none", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    prDraft: false,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: false,
    unresolvedThreadCount: 0,
    ciStatus: "none",
  });
  assert.equal(result.state, STATE.WAITING_FOR_CI);
  assert.notEqual(result.state, STATE.PR_READY_NO_FEEDBACK);
});

test("interpretLoopState returns waiting_for_copilot_review when Copilot is in requested_reviewers", () => {
  for (const status of ["requested", "already-requested"]) {
    const result = interpretLoopState({
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: status,
      copilotReviewPresent: false,
      copilotReviewOnCurrentHead: false,
      unresolvedThreadCount: 0,
    });
    assert.equal(result.state, STATE.WAITING_FOR_COPILOT_REVIEW, `failed for status=${status}`);
  }
});

// ---------------------------------------------------------------------------
// Regression: fresh Copilot review on current head should exit waiting_for_copilot_review
// ---------------------------------------------------------------------------

test("interpretLoopState keeps waiting_for_copilot_review while current-head request status remains active", () => {
  // Even with a submitted current-head review, an active requested_reviewers signal is
  // treated as not yet conclusively settled for this head.
  for (const status of ["requested", "already-requested"]) {
    const result = interpretLoopState({
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: status,
      copilotReviewPresent: true,
      copilotReviewOnCurrentHead: true,
      unresolvedThreadCount: 0,
      ciStatus: "success",
    });
    assert.equal(result.state, STATE.WAITING_FOR_COPILOT_REVIEW,
      `expected waiting_for_copilot_review while request status is ${status}`);
    assert.equal(result.autoRerequestEligible, false);
    assert.equal(result.sameHeadCleanConverged, false);
  }
});

test("applyConfirmedReviewRequest preserves review presence semantics for a fresh request", () => {
  const result = applyConfirmedReviewRequest({
    prExists: true,
    prNumber: 17,
    copilotReviewPresent: false,
    copilotReviewOnCurrentHead: false,
    copilotReviewRequestStatus: "none",
  }, "requested");

  assert.equal(result.copilotReviewRequestStatus, "requested");
  assert.equal(result.copilotReviewOnCurrentHead, false);
  assert.equal(result.copilotReviewPresent, false);
});

test("applyConfirmedReviewRequest clears current-head convergence without inventing a review", () => {
  const result = applyConfirmedReviewRequest({
    prExists: true,
    prNumber: 17,
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: true,
    copilotReviewRequestStatus: "none",
  }, "requested");

  assert.equal(result.copilotReviewRequestStatus, "requested");
  assert.equal(result.copilotReviewOnCurrentHead, false);
  assert.equal(result.copilotReviewPresent, true);
});

test("toSharedRequestStatus keeps shared enum members and collapses non-shared request outcomes to none", () => {
  for (const shared of ["requested", "already-requested", "unavailable", "none", "failed"]) {
    assert.equal(toSharedRequestStatus(shared), shared);
  }
  for (const nonShared of [
    "suppressed_post_convergence_docs_only",
    "round_cap_reached",
    "no_changes_since_last_review",
    "suppressed_same_head_clean",
    "suppressed_draft",
    "blocked_by_copilot_comment",
    undefined,
  ]) {
    assert.equal(toSharedRequestStatus(nonShared), "none");
  }
});

test("a suppressed_post_convergence_docs_only request routes to the round-cap converged/proceed disposition, never a Copilot wait", () => {
  // At the cap, a docs-only post-convergence suppression means "no fresh request
  // was placed; the prior converged review stands". Confirming that request result
  // onto the snapshot must NOT leave a stray non-shared status, and the loop must
  // route to the same clean round-cap fallback (terminal proceed) — not a wait.
  const snapshot = applyConfirmedReviewRequest({
    prExists: true,
    prNumber: 17,
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: true,
    copilotReviewRequestStatus: "none",
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  }, "suppressed_post_convergence_docs_only");

  // Non-shared status collapses to "none": nothing leaks into the shared contract.
  assert.equal(snapshot.copilotReviewRequestStatus, "none");

  const interpretation = interpretLoopState(snapshot, { maxCopilotRounds: 2 });
  assert.equal(interpretation.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.notEqual(interpretation.state, STATE.WAITING_FOR_COPILOT_REVIEW);

  const summary = summarizeLoopInterpretation(interpretation, { maxCopilotRounds: 2 });
  assert.equal(summary.loopDisposition, DISPOSITION.DONE);
  assert.equal(summary.terminal, true);
});

test("interpretLoopState stays in waiting_for_copilot_review when review is not yet on current head", () => {
  // Copilot is in requested_reviewers but has NOT submitted a review on this head yet
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "requested",
    copilotReviewPresent: false,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
  });
  assert.equal(result.state, STATE.WAITING_FOR_COPILOT_REVIEW);
});

test("interpretLoopState keeps waiting_for_copilot_review while request is active even when ci is pending", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "requested",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: true,
    unresolvedThreadCount: 0,
    ciStatus: "pending",
  });
  assert.equal(result.state, STATE.WAITING_FOR_COPILOT_REVIEW);
});

test("interpretLoopState returns ready_to_rerequest_review when Copilot has reviewed and all threads resolved", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    unresolvedThreadCount: 0,
    ciStatus: "success",
  });
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.ok(result.allowedTransitions.includes(STATE.WAITING_FOR_COPILOT_REVIEW));
  assert.ok(result.allowedTransitions.includes(STATE.DONE));
  assert.equal(result.autoRerequestEligible, true);
  assert.equal(result.sameHeadCleanConverged, false);
});

test("interpretLoopState treats crediblyGreen as a gate-eligible CI state", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: true,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    ciStatus: "crediblyGreen",
  });

  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(result.autoRerequestEligible, false);
  assert.equal(result.sameHeadCleanConverged, true);
});

test("interpretLoopState allows clean current-head convergence once request status is settled", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: true,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    ciStatus: "success",
  });
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(result.autoRerequestEligible, false);
  assert.equal(result.sameHeadCleanConverged, true);
});

test("interpretLoopState returns waiting_for_ci when Copilot has reviewed and ciStatus is none", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    unresolvedThreadCount: 0,
    ciStatus: "none",
  });
  assert.equal(result.state, STATE.WAITING_FOR_CI);
  assert.notEqual(result.state, STATE.READY_TO_REREQUEST_REVIEW);
});

test("interpretLoopState returns waiting_for_ci when CI is pending and no unresolved threads", () => {
  const noCopilotReview = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewPresent: false,
    unresolvedThreadCount: 0,
    ciStatus: "pending",
  });
  assert.equal(noCopilotReview.state, STATE.WAITING_FOR_CI);

  const withCopilotReview = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewPresent: true,
    unresolvedThreadCount: 0,
    ciStatus: "pending",
  });
  assert.equal(withCopilotReview.state, STATE.WAITING_FOR_CI);
});

test("interpretLoopState returns blocked_needs_user_decision for CI failure with no unresolved threads", () => {
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewPresent: true,
    unresolvedThreadCount: 0,
    ciStatus: "failure",
  });
  assert.equal(result.state, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.deepEqual(result.allowedTransitions, []);
});

test("interpretLoopState does not let CI status override unresolved thread routing", () => {
  // Even with CI failure, unresolved threads take priority
  const result = interpretLoopState({
    prExists: true,
    prNumber: 17,
    copilotReviewPresent: true,
    unresolvedThreadCount: 2,
    actionableThreadCount: 2,
    ciStatus: "failure",
  });
  assert.equal(result.state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
});

// ---------------------------------------------------------------------------
// interpretLoopState — return shape
// ---------------------------------------------------------------------------

test("interpretLoopState always returns state, allowedTransitions array, and non-empty nextAction", () => {
  const snapshots = [
    {},
    { prExists: true, prNumber: 1 },
    { prExists: true, prNumber: 1, prDraft: true },
    { prExists: true, prNumber: 1, copilotReviewRequestStatus: "requested" },
    { prExists: true, prNumber: 1, unresolvedThreadCount: 2 },
    { prExists: true, prNumber: 1, prMerged: true },
  ];

  for (const snapshot of snapshots) {
    const result = interpretLoopState(snapshot);
    assert.ok(typeof result.state === "string" && result.state.length > 0, "state must be non-empty string");
    assert.ok(Array.isArray(result.allowedTransitions), "allowedTransitions must be array");
    assert.ok(typeof result.nextAction === "string" && result.nextAction.length > 0, "nextAction must be non-empty string");
  }
});

test("interpretLoopState allowedTransitions array is a fresh copy each call", () => {
  const result1 = interpretLoopState({ prExists: true, prNumber: 1 });
  const result2 = interpretLoopState({ prExists: true, prNumber: 1 });
  result1.allowedTransitions.push("mutated");
  assert.notDeepEqual(result1.allowedTransitions, result2.allowedTransitions);
});

test("summarizeLoopInterpretation marks pending requested review as non-terminal", () => {
  const summary = summarizeLoopInterpretation({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "requested",
    unresolvedThreadCount: 0,
    ciStatus: "success",
  });

  assert.deepEqual(summary, {
    loopDisposition: DISPOSITION.PENDING,
    terminal: false,
  });
});

test("summarizeLoopInterpretation marks unresolved feedback as non-terminal", () => {
  const summary = summarizeLoopInterpretation({
    prExists: true,
    prNumber: 17,
    copilotReviewPresent: true,
    unresolvedThreadCount: 1,
    actionableThreadCount: 1,
    ciStatus: "success",
  });

  assert.deepEqual(summary, {
    loopDisposition: DISPOSITION.UNRESOLVED_FEEDBACK,
    terminal: false,
  });
});

test("summarizeLoopInterpretation marks same-head clean convergence as terminal", () => {
  const summary = summarizeLoopInterpretation({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: true,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    ciStatus: "success",
  });

  assert.deepEqual(summary, {
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    terminal: true,
  });
});

test("summarizeLoopInterpretation marks blocked states as terminal", () => {
  const summary = summarizeLoopInterpretation({
    prExists: true,
    prNumber: 17,
    copilotReviewPresent: true,
    unresolvedThreadCount: 0,
    ciStatus: "failure",
  });

  assert.deepEqual(summary, {
    loopDisposition: DISPOSITION.BLOCKED,
    terminal: true,
  });
});

// ---------------------------------------------------------------------------
// Low-signal heuristic
// ---------------------------------------------------------------------------

test("interpretLoopState applies low-signal heuristic when conditions met", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 1,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = {
    stopOnLowSignal: true,
    lowSignalRoundThreshold: 3,
    lowSignalMaxComments: 2,
  };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.LOW_SIGNAL_CONVERGED);
  assert.deepEqual(result.allowedTransitions, []);
  assert.match(result.nextAction, /Low-signal/i);
  assert.equal(result.autoRerequestEligible, false);
  assert.equal(result.sameHeadCleanConverged, false);
});

test("interpretLoopState does not apply low-signal when stopOnLowSignal is false", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 1,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = {
    stopOnLowSignal: false,
    lowSignalRoundThreshold: 3,
    lowSignalMaxComments: 2,
  };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
});

test("interpretLoopState does not apply low-signal when round count below threshold", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 2,
    ciStatus: "success",
  };

  const refinementConfig = {
    stopOnLowSignal: true,
    lowSignalRoundThreshold: 3,
    lowSignalMaxComments: 2,
  };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
});

test("interpretLoopState does not apply low-signal when actionable threads exceed limit", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 5,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = {
    stopOnLowSignal: true,
    lowSignalRoundThreshold: 3,
    lowSignalMaxComments: 2,
  };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
});

test("interpretLoopState does not apply low-signal without refinement config", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 10,
    ciStatus: "success",
  };

  const result = interpretLoopState(snapshot);
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
});

test("interpretLoopState does not apply low-signal to non-READY_TO_REREQUEST_REVIEW states", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    unresolvedThreadCount: 2,
    actionableThreadCount: 2,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = {
    stopOnLowSignal: true,
    lowSignalRoundThreshold: 3,
    lowSignalMaxComments: 2,
  };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
});

test("LOW_SIGNAL_CONVERGED state is terminal", () => {
  assert.deepEqual(TRANSITIONS[STATE.LOW_SIGNAL_CONVERGED], []);
  assert.ok(Object.prototype.hasOwnProperty.call(TRANSITIONS, STATE.LOW_SIGNAL_CONVERGED),
    "LOW_SIGNAL_CONVERGED must have a TRANSITIONS entry");
});

test("summarizeLoopInterpretation marks LOW_SIGNAL_CONVERGED as terminal", () => {
  const summary = summarizeLoopInterpretation({
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 1,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  }, {
    stopOnLowSignal: true,
    lowSignalRoundThreshold: 3,
    lowSignalMaxComments: 2,
  });

  assert.equal(summary.loopDisposition, DISPOSITION.DONE);
  assert.equal(summary.terminal, true);
});

test("interpretLoopState uses config default thresholds when not provided", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 4,
    ciStatus: "success",
  };

  const refinementConfig = { stopOnLowSignal: true };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.LOW_SIGNAL_CONVERGED,
    "should use default lowSignalRoundThreshold=3 and lowSignalMaxComments=2");
});

// ── Signal-gated suppression tests ───────────────────────────────────────

test("interpretLoopState suppresses when lastCopilotRoundMaxSignal is mid and threshold met", () => {
  const snapshot = {
    prExists: true, prNumber: 17,
    copilotReviewRequestStatus: "none", copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false, unresolvedThreadCount: 0,
    actionableThreadCount: 2, copilotReviewRoundCount: 5,
    lastCopilotRoundMaxSignal: "mid", ciStatus: "success",
  };
  const config = { stopOnLowSignal: true, lowSignalRoundThreshold: 3, lowSignalMaxComments: 2 };
  assert.equal(interpretLoopState(snapshot, config).state, STATE.LOW_SIGNAL_CONVERGED);
});

test("interpretLoopState suppresses when lastCopilotRoundMaxSignal is low", () => {
  const snapshot = {
    prExists: true, prNumber: 17,
    copilotReviewRequestStatus: "none", copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false, unresolvedThreadCount: 0,
    actionableThreadCount: 0, copilotReviewRoundCount: 4,
    lastCopilotRoundMaxSignal: "low", ciStatus: "success",
  };
  const config = { stopOnLowSignal: true, lowSignalRoundThreshold: 3, lowSignalMaxComments: 2 };
  assert.equal(interpretLoopState(snapshot, config).state, STATE.LOW_SIGNAL_CONVERGED);
});

test("interpretLoopState does NOT suppress when lastCopilotRoundMaxSignal is high", () => {
  const snapshot = {
    prExists: true, prNumber: 17,
    copilotReviewRequestStatus: "none", copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false, unresolvedThreadCount: 0,
    actionableThreadCount: 0, copilotReviewRoundCount: 5,
    lastCopilotRoundMaxSignal: "high", ciStatus: "success",
  };
  const config = { stopOnLowSignal: true, lowSignalRoundThreshold: 1, lowSignalMaxComments: 2 };
  assert.equal(interpretLoopState(snapshot, config).state, STATE.READY_TO_REREQUEST_REVIEW);
});

test("interpretLoopState falls back to actionableThreadCount when signal data is null", () => {
  const snapshot = {
    prExists: true, prNumber: 17,
    copilotReviewRequestStatus: "none", copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false, unresolvedThreadCount: 0,
    actionableThreadCount: 0, copilotReviewRoundCount: 4,
    lastCopilotRoundMaxSignal: null, ciStatus: "success",
  };
  const config = { stopOnLowSignal: true, lowSignalRoundThreshold: 3, lowSignalMaxComments: 2 };
  assert.equal(interpretLoopState(snapshot, config).state, STATE.LOW_SIGNAL_CONVERGED);
});

// ---------------------------------------------------------------------------
// Round-cap enforcement (maxCopilotRounds)
// ---------------------------------------------------------------------------

test("ROUND_CAP_REACHED and ROUND_CAP_CLEAN_FALLBACK are terminal states", () => {
  assert.deepEqual(TRANSITIONS[STATE.ROUND_CAP_REACHED], []);
  assert.deepEqual(TRANSITIONS[STATE.ROUND_CAP_CLEAN_FALLBACK], []);
  assert.ok(Object.prototype.hasOwnProperty.call(TRANSITIONS, STATE.ROUND_CAP_REACHED),
    "ROUND_CAP_REACHED must have a TRANSITIONS entry");
  assert.ok(Object.prototype.hasOwnProperty.call(TRANSITIONS, STATE.ROUND_CAP_CLEAN_FALLBACK),
    "ROUND_CAP_CLEAN_FALLBACK must have a TRANSITIONS entry");
});

test("TRANSITIONS covers ROUND_CAP_REACHED and ROUND_CAP_CLEAN_FALLBACK in completeness check", () => {
  for (const stateName of Object.values(STATE)) {
    assert.ok(Object.prototype.hasOwnProperty.call(TRANSITIONS, stateName),
      `missing transition entry for ${stateName}`);
  }
});

test("interpretLoopState routes to ROUND_CAP_REACHED when round cap reached with unresolved threads", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 2,
    actionableThreadCount: 2,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  // Round cap gates before unresolved-thread routing; unresolved threads + cap → hard stop
  assert.equal(result.state, STATE.ROUND_CAP_REACHED);
  assert.equal(result.roundCapCleanEligible, false);
});

test("interpretLoopState routes to ROUND_CAP_CLEAN_FALLBACK (no illegal re-request) when round cap reached after new commits with clean PR and green CI", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  // Head advanced past last submitted review, but the cap forbids another Copilot
  // round, so we must NOT re-open for re-request; pre_approval_gate handles the head.
  assert.equal(result.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.deepEqual(result.allowedTransitions, []);
  assert.equal(result.autoRerequestEligible, false);
  assert.equal(result.sameHeadCleanConverged, false);
  assert.equal(result.roundCapCleanEligible, true);
  assert.match(result.nextAction, /pre_approval_gate/i);
});

test("interpretLoopState routes to ROUND_CAP_CLEAN_FALLBACK (no illegal re-request) when round cap reached after new commits with crediblyGreen CI", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "crediblyGreen",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.equal(result.autoRerequestEligible, false);
  assert.equal(result.roundCapCleanEligible, true);
});

test("interpretLoopState fails closed to ROUND_CAP_CLEAN_FALLBACK when round-cap snapshot omits current-head review signal", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.equal(result.autoRerequestEligible, false);
  assert.equal(result.roundCapCleanEligible, true);
});

test("interpretLoopState routes to ROUND_CAP_CLEAN_FALLBACK at round cap when current head already has submitted Copilot review", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: true,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.deepEqual(result.allowedTransitions, []);
  assert.equal(result.autoRerequestEligible, false);
  assert.equal(result.sameHeadCleanConverged, false);
  assert.equal(result.roundCapCleanEligible, true);
  assert.match(result.nextAction, /pre_approval_gate/i);
});

test("interpretLoopState routes to ROUND_CAP_REACHED when round cap reached with clean threads but failing CI", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "failure",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  // Round cap gates before CI routing; failing CI + cap → hard stop
  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.ROUND_CAP_REACHED);
  assert.equal(result.roundCapCleanEligible, false);
});

test("interpretLoopState routes to ROUND_CAP_REACHED when round cap reached with clean threads and pending CI", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "pending",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  // Round cap gates before CI routing; pending CI + cap → hard stop
  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.ROUND_CAP_REACHED);
  assert.equal(result.roundCapCleanEligible, false);
});

test("interpretLoopState does not apply round cap when copilotReviewRoundCount is below maxCopilotRounds", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 3,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(result.roundCapCleanEligible, false);
  assert.equal(result.autoRerequestEligible, true);
});

// isCopilotRoundCapReached (#1126): the single shared predicate that both
// copilot-pr-handoff.mjs (via interpretLoopState) and
// detect-pr-gate-coordination-state.mjs (via evaluatePrGateCoordination) must
// consume so they cannot disagree at the cap boundary.
test("isCopilotRoundCapReached is true when completed rounds equal the cap", () => {
  assert.equal(isCopilotRoundCapReached({ copilotReviewRoundCount: 2, maxCopilotRounds: 2 }), true);
});

test("isCopilotRoundCapReached is true when completed rounds exceed the cap", () => {
  assert.equal(isCopilotRoundCapReached({ copilotReviewRoundCount: 3, maxCopilotRounds: 2 }), true);
});

test("isCopilotRoundCapReached is false when completed rounds are below the cap", () => {
  assert.equal(isCopilotRoundCapReached({ copilotReviewRoundCount: 1, maxCopilotRounds: 2 }), false);
});

test("isCopilotRoundCapReached is false when maxCopilotRounds is null, 0, or absent (cap disabled/unset)", () => {
  assert.equal(isCopilotRoundCapReached({ copilotReviewRoundCount: 5, maxCopilotRounds: null }), false);
  assert.equal(isCopilotRoundCapReached({ copilotReviewRoundCount: 5, maxCopilotRounds: 0 }), false);
  assert.equal(isCopilotRoundCapReached({ copilotReviewRoundCount: 5, maxCopilotRounds: undefined }), false);
});

test("interpretLoopState does not apply round cap when maxCopilotRounds is not configured", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 10,
    ciStatus: "success",
  };

  // No refinementConfig at all
  const result = interpretLoopState(snapshot);
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(result.roundCapCleanEligible, false);
});

test("interpretLoopState does not apply round cap when maxCopilotRounds is 0 or negative", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const result0 = interpretLoopState(snapshot, { maxCopilotRounds: 0 });
  assert.equal(result0.state, STATE.READY_TO_REREQUEST_REVIEW);

  const resultNeg = interpretLoopState(snapshot, { maxCopilotRounds: -1 });
  assert.equal(resultNeg.state, STATE.READY_TO_REREQUEST_REVIEW);
});

test("round cap overrides unresolved-thread routing when maxCopilotRounds is exceeded", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    unresolvedThreadCount: 3,
    actionableThreadCount: 3,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 3 };

  const result = interpretLoopState(snapshot, refinementConfig);
  // Round cap gates before unresolved-thread routing; cap exceeded → hard stop
  assert.equal(result.state, STATE.ROUND_CAP_REACHED);
  assert.equal(result.roundCapCleanEligible, false);
});

// Round-cap deadlock guard (#848): a lingering Copilot reviewer assignment
// (already-requested) must not dead-end the loop at WAITING_FOR_COPILOT_REVIEW once
// the cap is reached with a clean PR. The clean fallback takes priority over the
// stale assignment because no further Copilot round is permitted past the cap.
test("interpretLoopState routes to ROUND_CAP_CLEAN_FALLBACK when cap reached with clean PR despite lingering already-requested assignment", () => {
  const snapshot = {
    prExists: true,
    prNumber: 847,
    copilotReviewRequestStatus: "already-requested",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.notEqual(result.state, STATE.WAITING_FOR_COPILOT_REVIEW);
  assert.equal(result.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.equal(result.roundCapCleanEligible, true);
  assert.equal(result.autoRerequestEligible, false);
});

test("interpretLoopState routes to ROUND_CAP_CLEAN_FALLBACK (no illegal re-request) when cap reached with clean PR, head advanced, and lingering requested assignment", () => {
  const snapshot = {
    prExists: true,
    prNumber: 847,
    copilotReviewRequestStatus: "requested",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "crediblyGreen",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.equal(result.roundCapCleanEligible, true);
  // No illegal over-cap re-request is implied by the proceeding disposition.
  assert.equal(result.autoRerequestEligible, false);
});

test("interpretLoopState keeps WAITING_FOR_COPILOT_REVIEW when cap NOT reached with already-requested assignment (regression guard)", () => {
  const snapshot = {
    prExists: true,
    prNumber: 847,
    copilotReviewRequestStatus: "already-requested",
    copilotReviewPresent: false,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 2,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.WAITING_FOR_COPILOT_REVIEW);
  assert.equal(result.roundCapCleanEligible, false);
});

test("interpretLoopState keeps UNRESOLVED_FEEDBACK_PRESENT (not a clean fallback) when cap reached with unresolved threads and an in-flight request", () => {
  const snapshot = {
    prExists: true,
    prNumber: 847,
    copilotReviewRequestStatus: "already-requested",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 2,
    actionableThreadCount: 2,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  // Not clean + in-flight request: stays in the fix/wait routing rather than a clean
  // fallback. Unresolved threads take precedence over the lingering assignment.
  assert.equal(result.state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
  assert.equal(result.roundCapCleanEligible, false);
});

test("interpretLoopState does not produce a clean fallback when cap reached with failing CI and already-requested assignment", () => {
  const snapshot = {
    prExists: true,
    prNumber: 847,
    copilotReviewRequestStatus: "already-requested",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "failure",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  const result = interpretLoopState(snapshot, refinementConfig);
  // Not clean (failing CI) + in-flight request at the cap: falls through to the normal
  // wait routing (threads are 0 and a request is in flight) → WAITING_FOR_COPILOT_REVIEW,
  // never a clean fallback.
  assert.equal(result.state, STATE.WAITING_FOR_COPILOT_REVIEW);
  assert.equal(result.roundCapCleanEligible, false);
});

test("summarizeLoopInterpretation marks ROUND_CAP_REACHED as blocked and terminal", () => {
  // ROUND_CAP_REACHED is now reachable through normal routing when round cap gates
  // before unresolved-thread/CI checks. We simulate directly for summary test.
  const interpretation = {
    state: STATE.ROUND_CAP_REACHED,
    allowedTransitions: [],
    nextAction: "Stop",
    autoRerequestEligible: false,
    sameHeadCleanConverged: false,
    roundCapCleanEligible: false,
  };

  const summary = summarizeLoopInterpretation(interpretation);
  assert.equal(summary.loopDisposition, DISPOSITION.BLOCKED);
  assert.equal(summary.terminal, true);
});

test("summarizeLoopInterpretation marks ROUND_CAP_CLEAN_FALLBACK as done and terminal", () => {
  const interpretation = {
    state: STATE.ROUND_CAP_CLEAN_FALLBACK,
    allowedTransitions: [],
    nextAction: "Continue to pre_approval_gate",
    autoRerequestEligible: false,
    sameHeadCleanConverged: false,
    roundCapCleanEligible: true,
  };

  const summary = summarizeLoopInterpretation(interpretation);
  assert.equal(summary.loopDisposition, DISPOSITION.DONE);
  assert.equal(summary.terminal, true);
});

test("interpretLoopState returns false for roundCapCleanEligible in normal READY_TO_REREQUEST_REVIEW state", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 2,
    ciStatus: "success",
  };

  const result = interpretLoopState(snapshot, { maxCopilotRounds: 5 });
  assert.equal(result.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(result.roundCapCleanEligible, false);
});

test("round cap clean fallback takes priority over a lingering in-flight Copilot review request (no waiting dead-end)", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "requested",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  // At the cap, copilotReviewRoundCount counts COMPLETED rounds, so any in-flight
  // request is for a forbidden over-cap round. With a clean PR, the loop must proceed
  // to the pre_approval_gate fallback rather than dead-end at WAITING_FOR_COPILOT_REVIEW.
  const result = interpretLoopState(snapshot, refinementConfig);
  assert.notEqual(result.state, STATE.WAITING_FOR_COPILOT_REVIEW);
  assert.equal(result.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.equal(result.roundCapCleanEligible, true);
});

test("round cap with in-flight request but NOT clean stays in fix/wait routing (no premature clean fallback)", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "requested",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "pending",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  // Pending CI + in-flight request: not clean, so no clean fallback; the in-flight
  // request keeps the loop waiting for Copilot rather than forcing a hard stop.
  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.WAITING_FOR_COPILOT_REVIEW);
  assert.equal(result.roundCapCleanEligible, false);
});

test("round cap does not override BLOCKED_NEEDS_USER_DECISION from failed review request", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "failed",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
  };

  const refinementConfig = { maxCopilotRounds: 5 };

  // Round cap must not mask a real review-request failure
  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.equal(result.roundCapCleanEligible, false);
});

test("round-cap clean fallback takes priority over the low-signal heuristic at the cap", () => {
  const snapshot = {
    prExists: true,
    prNumber: 17,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 5,
    ciStatus: "success",
    lastCopilotRoundMaxSignal: "low",
  };

  const refinementConfig = {
    maxCopilotRounds: 5,
    stopOnLowSignal: true,
    lowSignalRoundThreshold: 3,
    lowSignalMaxComments: 2,
  };

  // At the cap with a clean PR the loop proceeds to the pre_approval_gate fallback.
  // The low-signal heuristic only suppresses a permitted re-request (READY_TO_REREQUEST_REVIEW),
  // which is forbidden at the cap, so it never applies here.
  const result = interpretLoopState(snapshot, refinementConfig);
  assert.equal(result.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.equal(result.roundCapCleanEligible, true);
});
