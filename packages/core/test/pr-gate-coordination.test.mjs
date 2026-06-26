import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePrGateCoordination,
  PR_CHECKPOINT_ACTION,
  PR_CHECKPOINT,
  shouldGuardCopilotReviewRequest,
} from "../src/loop/pr-gate-coordination.mjs";
import { DISPOSITION, STATE } from "../src/loop/copilot-loop-state.mjs";

function gate({ visible = false, headSha = null, verdict = null, contractComplete = false } = {}) {
  return {
    visible,
    headSha,
    verdict,
    contractComplete,
  };
}

test("draft PR only allows mark-ready after current-head clean draft gate evidence", () => {
  const result = evaluatePrGateCoordination({
    pr: 10,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert.equal(result.draftGate.currentHead, true);
  assert.equal(result.draftGate.currentHeadClean, true);
});

test("draft PR waits for CI before allowing draft gate when requireCi is enabled", () => {
  const result = evaluatePrGateCoordination({
    pr: 10,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.PENDING,
    ciStatus: "pending",
    draftGateRequireCi: true,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_CI);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.WAIT_FOR_CI));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert.match(result.reason, /requires green current-head CI before entering `draft_gate`/i);
});

test("draft PR allows draft gate without green CI when requireCi is disabled", () => {
  const result = evaluatePrGateCoordination({
    pr: 10,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    ciStatus: "pending",
    draftGateRequireCi: false,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
});

test("draft PR forbids mark-ready until current-head clean draft gate evidence exists", () => {
  const result = evaluatePrGateCoordination({
    pr: 10,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    ciStatus: "success",
    draftGate: gate({ visible: true, headSha: "old1111", verdict: "clean" }),
    draftGateMarker: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
});

test("draft PR rejects pre_approval_gate entry — must pass draft gate before pre-approval", () => {
  // A draft PR with no draft-gate evidence at all must forbid pre_approval_gate.
  const result = evaluatePrGateCoordination({
    pr: 543,
    currentHeadSha: "f7a611b723",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    ciStatus: "success",
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert.match(
    result.reason,
    /`draft_gate` is now the legal gate boundary before `gh pr ready`/i,
  );
  // Mark-ready is also forbidden (no current-head clean draft gate evidence yet).
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
  assert(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
});

test("stale gate markers do not report current-head contract completeness", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "def56789abcdef",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: true, headSha: "c94679e", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "c94679e", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.draftGate.currentHead, false);
  assert.equal(result.draftGate.contractComplete, false);
  assert.equal(result.draftGate.currentHeadClean, false);
});

test("non-draft PR with clean draft gate on a different head proceeds to post-draft flow (one-time boundary)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "def56789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: true, headSha: "c94679e", verdict: "clean" }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW);
  assert.equal(result.draftGate.visible, true);
  assert.equal(result.draftGate.currentHead, false);
  assert.equal(result.draftGate.cleanEvidenceExists, true);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("ready non-draft PR with current-head clean draft gate evidence requests Copilot review next", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "def56789abcdef",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: true, headSha: "def5678", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "def5678", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert.equal(result.draftGate.currentHeadClean, true);
});

test("waiting_for_ci recommends a dedicated wait-for-ci action", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "def56789abcdef",
    prDraft: false,
    lifecycleState: STATE.WAITING_FOR_CI,
    loopDisposition: DISPOSITION.PENDING,
    draftGate: gate({ visible: true, headSha: "def5678", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "def5678", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_CI);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.WAIT_FOR_CI));
  assert.match(result.reason, /waiting on current-head CI/i);
});

test("clean settled current-head review opens the pre-approval gate window", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("draft gate with crediblyGreen CI routes to WAIT_FOR_CI — unconfirmed CI is not a hard block", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    ciStatus: "crediblyGreen",
    draftGate: gate({ visible: false }),
    preApprovalGate: gate({ visible: false }),
  });
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_CI);
  assert.notEqual(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.match(result.reason, /so wait for CI to settle green/i);
});

test("crediblyGreen CI blocks pre-approval progression — CI must be confirmed before gate entry", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "crediblyGreen",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.lifecycleState, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.match(result.reason, /unconfirmed/i);
});
test("ciStatus failure blocks READY_TO_REREQUEST_REVIEW — primary issue-#552 scenario", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "failure",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });
  assert.equal(result.lifecycleState, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.match(result.reason, /failing/i);
});

test("round-cap exhaustion opens the pre-approval gate window even without a current-head Copilot rereview", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    sameHeadCleanConverged: false,
    ciStatus: "success",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.lifecycleState, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert.equal(result.gateEvidenceNote, "Copilot review rounds exhausted (5/5); current head has zero unresolved threads and green or credibly green CI, so pre_approval_gate fallback is allowed without another Copilot re-request.");
  assert.match(result.reason, /round limit/i);
  assert.match(result.reason, /pre_approval_gate/i);
});

// #896: a post-cap commit leaves the head unreviewed by Copilot. The interpreter
// resolves ROUND_CAP_CLEAN_FALLBACK (clean threads + green CI at the cap), and the
// coordinator must route that to the pre_approval_gate — which reviews the post-cap
// head itself (#848) — NOT dead-end at a rerequest the round cap forbids.
test("round_cap_clean_fallback routes a post-cap clean head to pre_approval_gate, not a rerequest dead-end (#896)", () => {
  const result = evaluatePrGateCoordination({
    pr: 892,
    currentHeadSha: "ef84bca2deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_CLEAN_FALLBACK,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    // post-cap head Copilot never reviewed → not same-head-clean-converged
    sameHeadCleanConverged: false,
    ciStatus: "success",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    // draft_gate evidence on an earlier head (round-cap clean fallback is the
    // draft-gate equivalent, #587); pre_approval not yet run on the new head.
    draftGate: gate({ visible: true, headSha: "7e0e303b", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "7e0e303b", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.lifecycleState, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  // The round cap forbids any further Copilot (re-)request from this state.
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
  assert.equal(result.draftGateAlreadySatisfied, true);
  assert.match(result.reason, /round limit is exhausted/i);
  assert.match(result.reason, /pre_approval_gate/i);
});

// #579 (gate review): a round-cap clean fallback with a clean current-head
// pre_approval_gate but NO clean draft_gate evidence must reconcile the draft
// gate, NOT jump to final approval. The detect-pr-gate-coordination-state #579
// post-pass unconditionally downgrades FINAL_APPROVAL_READY → DRAFT_GATE_NEEDED
// when draftGate.cleanEvidenceExists is false (no ROUND_CAP_CLEAN_FALLBACK
// exemption), so the core handler must agree to avoid a dead branch.
test("round_cap_clean_fallback with clean pre_approval but no draft_gate evidence reconciles the draft gate (#579 gate review)", () => {
  const result = evaluatePrGateCoordination({
    pr: 892,
    currentHeadSha: "ef84bca2deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_CLEAN_FALLBACK,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: false,
    ciStatus: "success",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: true, headSha: "ef84bca2", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "ef84bca2", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_GATE_NEEDED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE);
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  assert.equal(result.draftGateAlreadySatisfied, false);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
  assert.match(result.reason, /no gate exemptions, #579/i);
});

test("round_cap_clean_fallback with clean current-head pre_approval AND clean draft_gate evidence reaches final approval (#896)", () => {
  const result = evaluatePrGateCoordination({
    pr: 892,
    currentHeadSha: "ef84bca2deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_CLEAN_FALLBACK,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: false,
    ciStatus: "success",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    // clean draft_gate evidence on an earlier head satisfies the draft gate
    draftGate: gate({ visible: true, headSha: "7e0e303b", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "7e0e303b", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "ef84bca2", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "ef84bca2", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
  assert.equal(result.draftGate.cleanEvidenceExists, true);
  assert.equal(result.draftGateAlreadySatisfied, true);
  assert.match(result.reason, /round-cap clean fallback/i);
});

test("round_cap_clean_fallback still blocks on failing CI — genuinely-blocked states hold (#896)", () => {
  const result = evaluatePrGateCoordination({
    pr: 892,
    currentHeadSha: "ef84bca2deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_CLEAN_FALLBACK,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: false,
    ciStatus: "failure",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

// #896: the formal-request guard must not fire for a round-cap clean fallback —
// a post-cap clean head Copilot will not re-review. sameHeadCleanConverged is false
// here (Copilot did not review THIS head), so the pre-#896 escape would not apply;
// the explicit roundCapCleanFallback signal carries it.
test("guard returns false for round-cap clean fallback even without same-head clean converged (#896)", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    roundCapCleanFallback: true,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), false);
});

// Guard backward-compat: without the roundCapCleanFallback signal and without
// same-head clean convergence, the guard still fires at the cap (a not-clean cap
// head must still get a formal request path; #896 must not blanket-disable it).
test("guard still fires at the cap without a clean-fallback signal (#896 backward compat)", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    roundCapCleanFallback: false,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), true);
});

test("missing ciStatus fails closed to wait_for_ci instead of reopening gate progression", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.lifecycleState, STATE.WAITING_FOR_CI);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_CI);
});

test("current-head clean pre-approval evidence advances to final approval boundary", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    mergeStateStatus: "CLEAN",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
  assert.equal(result.preApprovalGate.currentHead, true);
  assert.equal(result.preApprovalGate.currentHeadClean, true);
  assert.equal(result.mergeStateStatus, "CLEAN");
  assert.deepEqual(result.conflictFiles, []);
});

test("retrospective merge gate blocks final approval when checkpoint is missing", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    requireRetrospectiveGate: true,
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.lifecycleState, "retrospective_gate_pending");
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.equal(result.loopDisposition, DISPOSITION.BLOCKED);
  assert.match(result.reason, /retrospective_gate_pending/i);
});

test("retrospective merge gate allows final approval when retrospective explicitly approves merge", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    requireRetrospectiveGate: true,
    retrospectiveCheckpoint: {
      state: "complete",
      gateQuality: "Real gates with concrete findings and follow-through.",
      mergeRecommendation: "Merge approved — all gates passed clean.",
      unexpectedFindings: "No unexpected findings.",
      behavioralReview: {
        mergeApproved: true,
        followedWorkingAgreement: true,
        gateQualityAcceptable: true,
        notes: "Real gates with concrete findings and follow-through.",
        drifts: ["No unexpected findings."],
      },
    },
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
});

test("retrospective merge gate: empty drifts array is valid (no unexpected findings)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    requireRetrospectiveGate: true,
    retrospectiveCheckpoint: {
      state: "complete",
      gateQuality: "All gates clean.",
      mergeRecommendation: "Proceed with merge.",
      behavioralReview: {
        mergeApproved: true,
        followedWorkingAgreement: true,
        gateQualityAcceptable: true,
        notes: "All gates clean.",
        drifts: [],
      },
    },
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
});

test("retrospective merge gate: missing gateQualityAcceptable blocks merge", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    requireRetrospectiveGate: true,
    retrospectiveCheckpoint: {
      state: "complete",
      mergeRecommendation: "Proceed.",
      behavioralReview: {
        mergeApproved: true,
        followedWorkingAgreement: true,
        notes: "Missing gateQualityAcceptable.",
        drifts: ["No unexpected findings."],
      },
    },
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.lifecycleState, "retrospective_gate_pending");
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.match(result.reason, /gateQuality/);
});

test("non-draft PR with clean draft_gate on a different head still allows post-draft flow (one-time boundary)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "newhead999999",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: true, headSha: "oldhead111", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "oldhead111", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.notEqual(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW);
  assert.equal(result.draftGate.currentHead, false);
  assert.equal(result.draftGate.cleanEvidenceExists, true);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert.equal(
    result.reason,
    "The PR is ready for review but the post-draft external review cycle has not started yet; request Copilot review before any `pre_approval_gate` entry.",
  );
});

test("non-draft PR without any clean draft_gate evidence still enters post-draft external review", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW);
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  assert.equal(result.draftGateAlreadySatisfied, false);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert.equal(
    result.reason,
    "The PR is ready for review but the post-draft external review cycle has not started yet; request Copilot review before any `pre_approval_gate` entry.",
  );
});

test("non-draft PR with visible non-clean draft_gate evidence still follows post-draft flow", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "findings_present" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "findings_present", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW);
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  assert.equal(result.draftGate.anyVisible, true);
  assert(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert.equal(
    result.reason,
    "The PR is ready for review but the post-draft external review cycle has not started yet; request Copilot review before any `pre_approval_gate` entry.",
  );
});


test("conflicted PR returns the conflict-resolution boundary and reports conflicted files", () => {
  const result = evaluatePrGateCoordination({
    pr: 370,
    currentHeadSha: "deadbeef1234",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    mergeStateStatus: "DIRTY",
    conflictFiles: ["config.test.mjs", "extension/README.md"],
    draftGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.CONFLICT_RESOLUTION);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS);
  assert.equal(result.mergeStateStatus, "DIRTY");
  assert.deepEqual(result.conflictFiles, ["config.test.mjs", "extension/README.md"]);
  assert.deepEqual(result.allowedNextActions, [PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS]);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY));
  assert.match(result.reason, /resolve the conflict locally on the PR branch/i);
  assert.match(result.reason, /config\.test\.mjs/i);
});

test("conflict state takes precedence over otherwise merge-ready current-head evidence", () => {
  const result = evaluatePrGateCoordination({
    pr: 370,
    currentHeadSha: "deadbeef1234",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    mergeStateStatus: "CONFLICTING",
    draftGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.CONFLICT_RESOLUTION);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY));
});

test("local git conflict files trigger the conflict-resolution boundary even without DIRTY mergeStateStatus", () => {
  const result = evaluatePrGateCoordination({
    pr: 370,
    currentHeadSha: "deadbeef1234",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    mergeStateStatus: "CLEAN",
    conflictFiles: [".pi/dev-loop/defaults.yaml"],
    draftGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.CONFLICT_RESOLUTION);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS);
  assert.deepEqual(result.conflictFiles, [".pi/dev-loop/defaults.yaml"]);
});

test("normalizeConflictFiles preserves opaque path strings while still rejecting blank entries", () => {
  const result = evaluatePrGateCoordination({
    pr: 370,
    currentHeadSha: "deadbeef1234",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    mergeStateStatus: "CLEAN",
    conflictFiles: ["  spaced-path.txt  ", "   ", "  spaced-path.txt  "],
    draftGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.deepEqual(result.conflictFiles, ["  spaced-path.txt  "]);
});

test("internal-only PR with explicit reviewMode skips to pre-approval gate after draft→ready", () => {
  const result = evaluatePrGateCoordination({
    pr: 298,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    reviewMode: "internal_only",
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  // Internal-only PRs skip Copilot review and go straight to pre-approval gate
  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW));
  assert.match(result.reason, /internal-only/i);
});

test("internal-only PR with both gates clean goes straight to final approval", () => {
  const result = evaluatePrGateCoordination({
    pr: 298,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    reviewMode: "internal_only",
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW));
  assert.match(result.reason, /internal-only/i);
});

test("PR without explicit reviewMode uses standard Copilot review path (default)", () => {
  const result = evaluatePrGateCoordination({
    pr: 298,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  // Without reviewMode, default to standard external Copilot review
  assert.equal(result.gateBoundary, PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

// #832: maxCopilotRounds: 0 disables the external Copilot review gate entirely
// (reusing the internal_only routing — skip Copilot, go to pre-approval).

test("maxCopilotRounds: 0 disables Copilot — ready PR skips to pre-approval gate", () => {
  const result = evaluatePrGateCoordination({
    pr: 298,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    maxCopilotRounds: 0,
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW));
  assert.match(result.reason, /disabled.*maxCopilotRounds: 0/i);
});

test("maxCopilotRounds: 0 with both gates clean goes straight to final approval (no Copilot)", () => {
  const result = evaluatePrGateCoordination({
    pr: 298,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    maxCopilotRounds: 0,
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW));
  assert.match(result.reason, /disabled.*maxCopilotRounds: 0/i);
});

test("shouldGuardCopilotReviewRequest: never forces a request when maxCopilotRounds is 0", () => {
  // At a pre-approval boundary, status none, never requested, not converged —
  // normally this would force a request; with the gate disabled it must not.
  const guarded = shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 0,
    copilotReviewEverFormallyRequested: false,
    maxCopilotRounds: 0,
    sameHeadCleanConverged: false,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
  });
  assert.equal(guarded, false);

  // Sanity: with the default cap it WOULD guard in the same situation.
  const guardedDefault = shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 0,
    copilotReviewEverFormallyRequested: false,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
  });
  assert.equal(guardedDefault, true);
});

test("internal-only PR without clean draft gate still enters pre-approval gate window", () => {
  const result = evaluatePrGateCoordination({
    pr: 298,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    reviewMode: "internal_only",
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW));
});

test("internal-only PR with retrospective gate blocks when checkpoint missing", () => {
  const result = evaluatePrGateCoordination({
    pr: 298,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    reviewMode: "internal_only",
    requireRetrospectiveGate: true,
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.lifecycleState, "retrospective_gate_pending");
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.match(result.reason, /retrospective_gate_pending/i);
});


test("PR_READY_NO_FEEDBACK internal_only blocks on CI failure", () => {
  const result = evaluatePrGateCoordination({
    pr: 553,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    reviewMode: "internal_only",
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    ciStatus: "failure",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });
  assert.equal(result.lifecycleState, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.match(result.reason, /failing CI/i);
});

test("PR_READY_NO_FEEDBACK internal_only blocks on crediblyGreen CI", () => {
  const result = evaluatePrGateCoordination({
    pr: 553,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    reviewMode: "internal_only",
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    ciStatus: "crediblyGreen",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });
  assert.equal(result.lifecycleState, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.match(result.reason, /unconfirmed/i);
});

test("internal-only PR with retrospective gate allows when approved", () => {
  const result = evaluatePrGateCoordination({
    pr: 298,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    reviewMode: "internal_only",
    requireRetrospectiveGate: true,
    retrospectiveCheckpoint: {
      state: "complete",
      behavioralReview: {
        mergeApproved: true,
        followedWorkingAgreement: true,
        gateQualityAcceptable: true,
        notes: "All gates clean.",
        drifts: ["No unexpected findings."],
      },
      gateQuality: "All gates clean.",
      mergeRecommendation: "Proceed with merge.",
    },
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW));
  assert.match(result.reason, /internal-only/i);
});

test("draft PR with clean current-head draft_gate sets cleanEvidenceExists", () => {
  const result = evaluatePrGateCoordination({
    pr: 10,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.draftGate.cleanEvidenceExists, true);
  assert.equal(result.draftGate.currentHeadClean, true);
});

test("converged non-draft PR without clean draft_gate evidence still enters pre-approval gate window", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert.equal(result.draftGate.anyVisible, false);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("converged non-draft PR without clean draft_gate evidence is blocked from final approval (#579 enforcement)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  // #579: FINAL_APPROVAL_READY requires clean draft_gate evidence — no exemptions
  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_GATE_NEEDED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE);
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  assert.equal(result.preApprovalGate.currentHeadClean, true);
  assert.match(result.reason, /no gate exemptions, #579/i);
});

// #587: round-cap clean fallback auto-satisfies draft gate requirement
// When roundCapReached + sameHeadCleanConverged + preApprovalGate clean,
// missing draft_gate evidence should not block final approval.
test("round-cap clean fallback allows final approval without draft_gate evidence (#587)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  // Round-cap clean fallback = draft gate equivalent → final approval
  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  // draftGateAlreadySatisfied must be true when roundCapReached bypasses draft gate
  assert.equal(result.draftGateAlreadySatisfied, true);
  assert.match(result.reason, /round-cap clean fallback/i);
  assert.match(result.reason, /draft gate equivalent/i);
  assert.match(result.reason, /5\/5 rounds/i);
  assert.ok(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
  assert.ok(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE));
});

// Backward compat: non-round-cap path still requires draft_gate evidence
test("non-round-cap PR without draft_gate evidence is still blocked from final approval (#587 backward compat)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    copilotReviewRoundCount: 3,
    maxCopilotRounds: 5,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  // Not at round cap → still blocked on draft_gate
  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_GATE_NEEDED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE);
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  assert.match(result.reason, /no gate exemptions, #579/i);
});

test("#836: a PR un-drafted externally before draft_gate ran is caught at the merge boundary (reconcile_draft_gate, #579) — the out-of-order transition is no longer silent", () => {
  // #836 defect 2: a PR was marked ready-for-review outside the loop, so draft_gate never ran
  // and no draft_gate comment exists. The original report was that "no detector caught the
  // out-of-order transition." It is caught now: a non-draft PR with no clean draft_gate evidence
  // (and not in the round-cap clean-fallback equivalence of #587) cannot reach final approval —
  // it routes to reconcile_draft_gate and merge is forbidden.
  const result = evaluatePrGateCoordination({
    pr: 20326,
    currentHeadSha: "abc123456789",
    prDraft: false, // un-drafted externally
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 5, // NOT at the cap → the #587 round-cap draft-gate equivalence does not apply
    draftGate: gate({ visible: false }), // draft_gate never ran
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_GATE_NEEDED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE);
  assert.equal(result.draftGateAlreadySatisfied, false);
  // Lock the "draft_gate never ran" precondition: no clean evidence, and no visible
  // draft_gate comment at all (matches the surrounding #579/#587 tests).
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  assert.equal(result.draftGate.anyVisible, false);
  assert.ok(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY));
  assert.match(result.reason, /no gate exemptions, #579/i);
});


// ── LOW_SIGNAL_CONVERGED gate routing tests ─────────────────────────────

import { normalizeSnapshot } from "../src/loop/copilot-loop-state.mjs";

test("LOW_SIGNAL_CONVERGED routes to pre-approval gate when CI is green", () => {
  const result = evaluatePrGateCoordination({
    repo: "owner/repo", pr: 17,
    lifecycleState: STATE.LOW_SIGNAL_CONVERGED,
    loopDisposition: DISPOSITION.DONE,
    prDraft: false, ciStatus: "success",
    draftGate: { visible: true, verdict: "clean", headSha: "abc1234" },
    preApprovalGate: {},
  });
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.ok(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW));
  assert.match(result.reason, /low-signal/i);
});

test("LOW_SIGNAL_CONVERGED with clean pre-approval gate advances to final approval", () => {
  const result = evaluatePrGateCoordination({
    repo: "owner/repo", pr: 17, currentHeadSha: "abc1234",
    lifecycleState: STATE.LOW_SIGNAL_CONVERGED, loopDisposition: DISPOSITION.DONE,
    prDraft: false, ciStatus: "success",
    preApprovalGate: { visible: true, verdict: "clean", headSha: "abc1234" },
    preApprovalGateMarker: { visible: true, verdict: "clean", headSha: "abc1234", contractComplete: true },
    draftGate: { visible: true, verdict: "clean", headSha: "abc1234" },
  });
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
  assert.match(result.reason, /low-signal/i);
});

test("LOW_SIGNAL_CONVERGED waits for CI when pending", () => {
  const result = evaluatePrGateCoordination({
    repo: "owner/repo", pr: 17,
    lifecycleState: STATE.LOW_SIGNAL_CONVERGED, loopDisposition: DISPOSITION.DONE,
    prDraft: false, ciStatus: "pending",
    draftGate: { visible: true, verdict: "clean", headSha: "abc1234" },
    preApprovalGate: {},
  });
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_CI);
});

test("LOW_SIGNAL_CONVERGED blocks on CI failure", () => {
  const result = evaluatePrGateCoordination({
    repo: "owner/repo", pr: 17,
    lifecycleState: STATE.LOW_SIGNAL_CONVERGED, loopDisposition: DISPOSITION.DONE,
    prDraft: false, ciStatus: "failure",
    draftGate: { visible: true, verdict: "clean", headSha: "abc1234" },
    preApprovalGate: {},
  });
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
});
test("LOW_SIGNAL_CONVERGED blocks on crediblyGreen CI", () => {
  const result = evaluatePrGateCoordination({
    repo: "owner/repo", pr: 17,
    lifecycleState: STATE.LOW_SIGNAL_CONVERGED, loopDisposition: DISPOSITION.DONE,
    prDraft: false, ciStatus: "crediblyGreen",
    draftGate: { visible: true, verdict: "clean", headSha: "abc1234" },
    preApprovalGate: {},
  });
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.match(result.reason, /unconfirmed/i);
});

test("LOW_SIGNAL_CONVERGED without clean draft_gate evidence is blocked from final approval (#579)", () => {
  const result = evaluatePrGateCoordination({
    repo: "owner/repo", pr: 17, currentHeadSha: "abc1234",
    lifecycleState: STATE.LOW_SIGNAL_CONVERGED, loopDisposition: DISPOSITION.DONE,
    prDraft: false, ciStatus: "success",
    preApprovalGate: { visible: true, verdict: "clean", headSha: "abc1234" },
    preApprovalGateMarker: { visible: true, verdict: "clean", headSha: "abc1234", contractComplete: true },
    draftGate: { visible: false },
  });
  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_GATE_NEEDED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE);
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  assert.match(result.reason, /no gate exemptions, #579/i);
});

test("internal-only PR without clean draft_gate evidence is blocked from final approval (#579)", () => {
  const result = evaluatePrGateCoordination({
    pr: 298, currentHeadSha: "abc123456789",
    prDraft: false, lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED, reviewMode: "internal_only",
    draftGate: gate({ visible: false }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });
  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_GATE_NEEDED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE);
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  assert.match(result.reason, /no gate exemptions, #579/i);
  assert.ok(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
});

test("converged PR with findings_present draft_gate is blocked from final approval (#579 cleanEvidenceExists)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266, currentHeadSha: "abc123456789",
    prDraft: false, lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED, sameHeadCleanConverged: true,
    ciStatus: "success",
    draftGate: gate({ visible: true, headSha: "old1111", verdict: "findings_present" }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });
  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_GATE_NEEDED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE);
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  assert.equal(result.draftGate.anyVisible, true);
  assert.match(result.reason, /no gate exemptions, #579/i);
});



test("normalizeSnapshot preserves valid lastCopilotRoundMaxSignal", () => {
  assert.equal(normalizeSnapshot({ prExists: true, prNumber: 17, lastCopilotRoundMaxSignal: "high" }).lastCopilotRoundMaxSignal, "high");
  assert.equal(normalizeSnapshot({ prExists: true, prNumber: 17, lastCopilotRoundMaxSignal: "mid" }).lastCopilotRoundMaxSignal, "mid");
  assert.equal(normalizeSnapshot({ prExists: true, prNumber: 17, lastCopilotRoundMaxSignal: "low" }).lastCopilotRoundMaxSignal, "low");
});

test("normalizeSnapshot rejects invalid lastCopilotRoundMaxSignal values", () => {
  assert.equal(normalizeSnapshot({ prExists: true, prNumber: 17, lastCopilotRoundMaxSignal: "critical" }).lastCopilotRoundMaxSignal, null);
  assert.equal(normalizeSnapshot({ prExists: true, prNumber: 17, lastCopilotRoundMaxSignal: "" }).lastCopilotRoundMaxSignal, null);
  assert.equal(normalizeSnapshot({ prExists: true, prNumber: 17 }).lastCopilotRoundMaxSignal, null);
});

test("gateEvidenceRequiredForMerge is always true in coordination output", () => {
  const result = evaluatePrGateCoordination({
    pr: 10,
    currentHeadSha: "abc1234",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateEvidenceRequiredForMerge, true);
});

test("draft PR is blocked when refinement artifact is missing on linked issue (#532)", () => {
  const result = evaluatePrGateCoordination({
    pr: 532,
    currentHeadSha: "abc1234567",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    refinementArtifact: {
      status: "missing",
      linkedIssue: 532,
      source: "missing",
      reason: "Issue body has no Acceptance criteria section, no DoD section, and no linked refinement doc.",
      finding: "missing_refinement_artifact",
    },
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY));
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REPORT_BLOCKED));
  assert.match(result.reason, /no refinement artifact/i);
  assert.match(result.reason, /#532/);
  assert.match(result.reason, /missing_refinement_artifact/);
  assert.equal(result.refinementArtifact?.status, "missing");
  assert.equal(result.refinementArtifact?.linkedIssue, 532);
});

test("draft PR is not blocked when refinement artifact is present (#532)", () => {
  const result = evaluatePrGateCoordination({
    pr: 532,
    currentHeadSha: "abc1234567",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    ciStatus: "success",
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    refinementArtifact: {
      status: "present",
      linkedIssue: 532,
      source: "issue-body-ac",
      acItems: ["First AC", "Second AC"],
      reason: "Found 2 Acceptance criteria checklist item(s) in the issue body.",
    },
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert.equal(result.refinementArtifact?.status, "present");
});

test("refinement block takes precedence over non-draft branches for draft PRs", () => {
  const result = evaluatePrGateCoordination({
    pr: 10,
    currentHeadSha: "abc1234567",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    mergeStateStatus: "CLEAN",
    conflictFiles: [],
    refinementArtifact: {
      status: "missing",
      linkedIssue: 10,
      source: "missing",
      reason: "no artifact",
      finding: "missing_refinement_artifact",
    },
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
});

test("non-draft PRs do not block on missing refinement artifact (already left draft)", () => {
  const result = evaluatePrGateCoordination({
    pr: 10,
    currentHeadSha: "abc1234567",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    refinementArtifact: {
      status: "missing",
      linkedIssue: 10,
      source: "missing",
      reason: "no artifact",
    },
  });

  assert.notEqual(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.refinementArtifact?.status, "missing");
});

// ── Branch freshness (BEHIND) gate tests (#566) ─────────────────────────

test("BEHIND mergeStateStatus blocks draft_gate entry (#566)", () => {
  const result = evaluatePrGateCoordination({
    pr: 10,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    ciStatus: "success",
    mergeStateStatus: "BEHIND",
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.CONFLICT_RESOLUTION);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS);
  assert.equal(result.mergeStateStatus, "BEHIND");
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY));
  assert.match(result.reason, /branch must be updated from base/i);
});

test("BEHIND mergeStateStatus blocks pre_approval_gate entry (#566)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    mergeStateStatus: "BEHIND",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.CONFLICT_RESOLUTION);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS);
  assert.equal(result.mergeStateStatus, "BEHIND");
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY));
  assert.match(result.reason, /branch must be updated from base/i);
});

test("BEHIND takes precedence over clean settled review cycle (#566)", () => {
  const result = evaluatePrGateCoordination({
    pr: 370,
    currentHeadSha: "deadbeef1234",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    mergeStateStatus: "BEHIND",
    draftGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.CONFLICT_RESOLUTION);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS);
  assert.equal(result.mergeStateStatus, "BEHIND");
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY));
  assert.match(result.reason, /branch must be updated from base/i);
});

test("BEHIND blocks even when both gates have clean current-head evidence (#566)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    mergeStateStatus: "BEHIND",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.CONFLICT_RESOLUTION);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS);
  assert.match(result.reason, /branch must be updated from base/i);
});

test("CLEAN mergeStateStatus still allows gate progression (#566 regression guard)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    mergeStateStatus: "CLEAN",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
});

test("mergeStateStatus null still allows gate progression (#566 regression guard)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    mergeStateStatus: null,
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
});

// --- Copilot review request guard (#613) ---

test("shouldGuardCopilotReviewRequest returns true when copilot reviewed without formal request at pre_approval_gate", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 1,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), true);
});

test("guard returns false when formal request was made (requested)", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "requested",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: true,
    gateBoundary: PR_CHECKPOINT.FINAL_APPROVAL_READY,
  }), false);
});

test("guard returns false when already-requested", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "already-requested",
    copilotReviewRoundCount: 1,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
  }), false);
});

test("guard returns false for non-pre-approval gate boundaries", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 1,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    gateBoundary: PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
  }), false);
});

test("guard returns false for round-cap clean fallback (exhausted rounds + clean converged)", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: true,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), false);
});

test("guard returns true for exhausted rounds without clean converged (round cap not clean)", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), true);
});

test("guard returns true when maxCopilotRounds is null (no round cap configured)", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 100,
    maxCopilotRounds: null,
    sameHeadCleanConverged: true,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), true);
});


test("guard returns false when Copilot was ever formally requested (durable signal)", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 1,
    copilotReviewEverFormallyRequested: true,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), false);
});

test("guard returns true when Copilot was never formally requested and status is none", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 1,
    copilotReviewEverFormallyRequested: false,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), true);
});

test("guard uses default false for copilotReviewEverFormallyRequested (backward compat)", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 1,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), true);
});
test("guard returns false when review request status is unavailable", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "unavailable",
    copilotReviewRoundCount: 1,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), false);
});

// #842: a merge-blocking marker in the PR title must re-block the
// final-approval boundary, mirroring the mark-ready transition guard.

test("WIP title blocks an otherwise final-approval-ready PR (title_marker_blocked)", () => {
  const result = evaluatePrGateCoordination({
    pr: 842,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    reviewMode: "internal_only",
    prTitle: "[WIP] add authentication flow",
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.lifecycleState, "title_marker_blocked");
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.deepEqual(result.allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]);
  assert.match(result.reason, /merge-blocking marker/i);
  assert.match(result.reason, /WIP/);
});

test("clean title still reaches final_approval_ready (title-marker control)", () => {
  const result = evaluatePrGateCoordination({
    pr: 842,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    reviewMode: "internal_only",
    prTitle: "Add user authentication flow",
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
});

test("title marker takes precedence over a missing retrospective checkpoint", () => {
  const result = evaluatePrGateCoordination({
    pr: 842,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    reviewMode: "internal_only",
    requireRetrospectiveGate: true,
    prTitle: "DO NOT MERGE: pending infra",
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.lifecycleState, "title_marker_blocked");
  assert.match(result.reason, /DO NOT MERGE/);
});

// #842 site 2: the converged settled-review branch
// (READY_TO_REREQUEST_REVIEW / CLEAN_CONVERGED with sameHeadCleanConverged).

test("WIP title blocks the converged settled-review final-approval site (site 2)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    mergeStateStatus: "CLEAN",
    prTitle: "WIP: rework review loop",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.lifecycleState, "title_marker_blocked");
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.match(result.reason, /merge-blocking marker/i);
  assert.match(result.reason, /WIP/);
});

test("clean title still reaches final_approval_ready at the converged settled-review site (site 2)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    mergeStateStatus: "CLEAN",
    prTitle: "Rework review loop convergence",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
});

// #842 site 3: the low-signal / round-cap heuristic branch
// (LOW_SIGNAL_CONVERGED with clean pre-approval evidence).

test("WIP title blocks the low-signal heuristic final-approval site (site 3)", () => {
  const result = evaluatePrGateCoordination({
    repo: "owner/repo", pr: 17, currentHeadSha: "abc1234",
    lifecycleState: STATE.LOW_SIGNAL_CONVERGED, loopDisposition: DISPOSITION.DONE,
    prDraft: false, ciStatus: "success",
    prTitle: "🚧 still wiring up the heuristic",
    preApprovalGate: { visible: true, verdict: "clean", headSha: "abc1234" },
    preApprovalGateMarker: { visible: true, verdict: "clean", headSha: "abc1234", contractComplete: true },
    draftGate: { visible: true, verdict: "clean", headSha: "abc1234" },
  });

  assert.equal(result.lifecycleState, "title_marker_blocked");
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.match(result.reason, /merge-blocking marker/i);
  assert.match(result.reason, /🚧/);
});

test("clean title still reaches final_approval_ready at the low-signal heuristic site (site 3)", () => {
  const result = evaluatePrGateCoordination({
    repo: "owner/repo", pr: 17, currentHeadSha: "abc1234",
    lifecycleState: STATE.LOW_SIGNAL_CONVERGED, loopDisposition: DISPOSITION.DONE,
    prDraft: false, ciStatus: "success",
    prTitle: "Wire up the convergence heuristic",
    preApprovalGate: { visible: true, verdict: "clean", headSha: "abc1234" },
    preApprovalGateMarker: { visible: true, verdict: "clean", headSha: "abc1234", contractComplete: true },
    draftGate: { visible: true, verdict: "clean", headSha: "abc1234" },
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
});

// #842 AC2: a WIP/DRAFT/DO NOT MERGE/🚧 title must also block the pre-approval
// gate ENTRY boundary for non-draft PRs (e.g. a PR un-drafted externally,
// bypassing ready-for-review). Draft PRs are NOT blocked — a WIP title is fine
// while the work is still in draft.

test("WIP title blocks a non-draft PR at the pre-approval gate boundary (#842 AC2)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    prTitle: "[WIP] converge the review loop",
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.lifecycleState, "title_marker_blocked");
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert.match(result.reason, /merge-blocking marker/i);
  assert.match(result.reason, /WIP/);
});

test("clean title still reaches the pre-approval gate boundary for a non-draft PR (#842 AC2 control)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    prTitle: "Converge the review loop",
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("draft PR with a WIP title is NOT blocked by the title guard (#842 AC2 — draft work continues)", () => {
  const result = evaluatePrGateCoordination({
    pr: 10,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    prTitle: "[WIP] still building this",
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });

  assert.notEqual(result.lifecycleState, "title_marker_blocked");
  assert.notEqual(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.draftGate.cleanEvidenceExists, true);
});
