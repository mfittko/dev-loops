import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePrGateCoordination,
  PR_CHECKPOINT_ACTION,
  PR_CHECKPOINT,
  shouldGuardCopilotReviewRequest,
} from "../src/loop/pr-gate-coordination.mjs";
import { DISPOSITION, interpretLoopState, STATE } from "../src/loop/copilot-loop-state.mjs";

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

// Issue #1190: gate-ENTRY re-check. Even when the caller asserts convergence
// (sameHeadCleanConverged: true, the same fixture as the test above), an
// independent, outstanding Copilot review request on the current head must
// refuse pre_approval_gate entry outright — the same predicate that
// previously only fired at verdict-post time (upsert-checkpoint-verdict.mjs)
// now also fires here, before any reviewer fan-out spends tokens.
test("#1190: outstanding Copilot review request refuses pre_approval_gate entry even when the caller "
  + "claims sameHeadCleanConverged", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    copilotReviewRequestStatus: "requested",
    ciStatus: "success",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert.match(result.reason, /outstanding/i);
  // Bypass regression: the synthesized wait result must forbid the FULL
  // postDraftForbidden set — dropping run_draft_gate here would let
  // upsert-checkpoint-verdict post a draft_gate verdict on a non-draft PR
  // (gate=draft_gate, no clean draft evidence, outstanding request) where the
  // replaced boundary result would have refused it.
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY));
  // Shape consistency with sibling wait-state results.
  assert.equal(result.copilotReviewRoundCount, 0);
});

test("#1190: already-requested Copilot review also refuses pre_approval_gate entry", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    sameHeadCleanConverged: true,
    copilotReviewRequestStatus: "already-requested",
    ciStatus: "success",
    preApprovalGate: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("#1190: round-cap clean fallback with a lingering review request still permits pre_approval_gate "
  + "entry (no re-introduction of the #896 infinite-wait dead-end)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_CLEAN_FALLBACK,
    ciStatus: "success",
    copilotReviewRoundCount: 3,
    maxCopilotRounds: 3,
    // Past the cap this lingering request is for a round that can never come;
    // the entry guard must NOT treat it as unsettled (#896/#848 exemption).
    copilotReviewRequestStatus: "requested",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("#1190: at the cap, significant post-convergence changes re-arm the outstanding-review entry guard "
  + "(clean-fallback exemption does not apply when a new cycle is required)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    ciStatus: "success",
    sameHeadCleanConverged: true,
    copilotReviewRoundCount: 3,
    maxCopilotRounds: 3,
    copilotReviewRequestStatus: "requested",
    postConvergenceSignificantChange: true,
    preApprovalGate: gate({ visible: false }),
  });

  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("#1190: internal_only reviewMode is exempt from the outstanding-review entry guard (#1210 lightweight cap)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    sameHeadCleanConverged: true,
    copilotReviewRequestStatus: "requested",
    reviewMode: "internal_only",
    ciStatus: "success",
    preApprovalGate: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("#1190: maxCopilotRounds: 0 (Copilot review disabled) is exempt from the outstanding-review entry guard", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    sameHeadCleanConverged: true,
    copilotReviewRequestStatus: "requested",
    maxCopilotRounds: 0,
    ciStatus: "success",
    preApprovalGate: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
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
  assert.equal(result.gateEvidenceNote, "Copilot review rounds exhausted (5/5); current head has zero unresolved threads and green CI, so pre_approval_gate fallback is allowed without another Copilot re-request.");
  assert.match(result.reason, /round limit/i);
  assert.match(result.reason, /pre_approval_gate/i);
});

// #1472: this is the SAME reachable branch as the test above (READY_TO_REREQUEST_REVIEW
// at the round cap, PRE_APPROVAL_GATE_WINDOW) — the only difference is
// preApprovalRequireCi:false with a failing CI. Before this fix,
// buildRoundExhaustionGateEvidenceNote's two pre-existing call sites omitted
// ciStatus/preApprovalRequireCi, so both the gateEvidenceNote and the reason
// string claimed "green or credibly green CI" / "green CI" for a head whose
// CI is literally failing. Pins the honest wording on the production path
// real callers actually take (not just the new, narrower ROUND_CAP_REACHED branch).
test("round-cap exhaustion with requireCi:false and failing CI does not claim green CI (#1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    sameHeadCleanConverged: false,
    ciStatus: "failure",
    preApprovalRequireCi: false,
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert.doesNotMatch(result.reason, /green CI/i);
  assert.match(result.reason, /CI not required by config/i);
  assert.doesNotMatch(result.gateEvidenceNote, /green CI/i);
  assert.match(result.gateEvidenceNote, /CI not required by config/i);
});

// #1387: at ROUND_CAP_CLEAN_FALLBACK, a post-convergence significant change must
// NOT force rerequest_copilot_review — the round cap makes that rerequest
// impossible (request-copilot-review.mjs suppresses it), so the only allowed
// action would be a dead end. The pre_approval_gate fan-out reviews the
// current post-cap head, which IS the review of the significant change —
// matching detect-copilot-loop-state's own ROUND_CAP_CLEAN_FALLBACK nextAction.
test("post-convergence significant change at the round cap allows pre_approval_gate instead of an impossible rerequest (#1387)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_CLEAN_FALLBACK,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: false,
    ciStatus: "success",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    postConvergenceSignificantChange: true,
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  // The impossible rerequest must never be offered — the round cap forbids it.
  assert(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
});

// #1387: below the cap, a not-yet-settled review cycle (e.g. a significant
// post-convergence change landed on a newer head) still reopens a new Copilot
// cycle (no regression) — a rerequest is always POSSIBLE below the cap, so
// only AT the cap (where it is impossible) does the routing change.
test("post-convergence significant change below the round cap still reopens a new Copilot cycle (#1387 no regression)", () => {
  const result = evaluatePrGateCoordination({
    pr: 266,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    sameHeadCleanConverged: false,
    ciStatus: "success",
    copilotReviewRoundCount: 3,
    maxCopilotRounds: 5,
    postConvergenceSignificantChange: true,
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
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

// #1472: same reachable branch as the test above (ROUND_CAP_CLEAN_FALLBACK,
// PRE_APPROVAL_GATE_WINDOW) with preApprovalRequireCi:false and a failing CI.
// buildRoundExhaustionGateEvidenceNote's call site here (and the sibling reason
// string) omitted ciStatus/preApprovalRequireCi before this fix, so a failing
// head still got told its CI was "green" in both the gateEvidenceNote and the
// reason posted to the gate comment — the exact false claim this PR set out
// to remove, but only fixed (pre-fix) on an interpreter-unreachable branch.
test("round_cap_clean_fallback with requireCi:false and failing CI does not claim green CI (#1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 892,
    currentHeadSha: "ef84bca2deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_CLEAN_FALLBACK,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: false,
    ciStatus: "failure",
    preApprovalRequireCi: false,
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    draftGate: gate({ visible: true, headSha: "7e0e303b", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "7e0e303b", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert.doesNotMatch(result.reason, /green CI/i);
  assert.match(result.reason, /CI not required by config/i);
  assert.doesNotMatch(result.gateEvidenceNote, /green CI/i);
  assert.match(result.gateEvidenceNote, /CI not required by config/i);
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

// #1371 re-verify: crediblyGreen is never accepted unconditionally — the
// round-cap clean fallback rejects it identically to a real CI failure
// (fail-closed), same as every other post-draft boundary.
test("round_cap_clean_fallback blocks on crediblyGreen CI — unconfirmed CI is never accepted (#1371)", () => {
  const result = evaluatePrGateCoordination({
    pr: 892,
    currentHeadSha: "ef84bca2deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_CLEAN_FALLBACK,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: false,
    ciStatus: "crediblyGreen",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.lifecycleState, STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert.match(result.reason, /unconfirmed/i);
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

test("guard does not suppress formal-request checks when significant post-convergence changes require a new cycle", () => {
  assert.equal(shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus: "none",
    copilotReviewRoundCount: 5,
    maxCopilotRounds: 5,
    sameHeadCleanConverged: false,
    roundCapCleanFallback: true,
    postConvergenceSignificantChange: true,
    gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  }), true);
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

// Parity (#1126): copilot-pr-handoff.mjs enforces the round cap by calling
// interpretLoopState; detect-pr-gate-coordination-state.mjs enforces it by
// calling evaluatePrGateCoordination. Both must reach the shared
// isCopilotRoundCapReached predicate (via copilot-loop-state.mjs) for the same
// PR facts and agree on whether a Copilot re-request may be offered — the
// coordination-state detector must never advertise `rerequest_copilot_review`
// once the handoff would refuse it.
test("interpretLoopState (handoff) and evaluatePrGateCoordination (coordination-state) agree at the round-cap boundary — no rerequest offered (#1126)", () => {
  const refinementConfig = { maxCopilotRounds: 2 };
  const snapshot = {
    prExists: true,
    prNumber: 500,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 2, // == maxCopilotRounds: exactly at the cap
    ciStatus: "success",
  };

  // copilot-pr-handoff.mjs's path.
  const handoffInterpretation = interpretLoopState(snapshot, refinementConfig);
  assert.equal(handoffInterpretation.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.equal(handoffInterpretation.roundCapCleanEligible, true);

  // detect-pr-gate-coordination-state.mjs's path, fed the same lifecycle state
  // and round-count/cap inputs it would derive from the same PR facts.
  const gateResult = evaluatePrGateCoordination({
    pr: 500,
    currentHeadSha: "deadbeefcafe",
    prDraft: false,
    lifecycleState: handoffInterpretation.state,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: handoffInterpretation.sameHeadCleanConverged,
    ciStatus: snapshot.ciStatus,
    copilotReviewRoundCount: snapshot.copilotReviewRoundCount,
    maxCopilotRounds: refinementConfig.maxCopilotRounds,
    draftGate: gate({ visible: true, headSha: "deadbeef", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "deadbeef", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.notEqual(gateResult.nextAction, PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW);
  assert(!gateResult.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
  assert(gateResult.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
});

test("interpretLoopState (handoff) and evaluatePrGateCoordination (coordination-state) agree below the round cap — rerequest_copilot_review is still allowed (#1126, no regression)", () => {
  const refinementConfig = { maxCopilotRounds: 2 };
  const snapshot = {
    prExists: true,
    prNumber: 501,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 1, // below maxCopilotRounds: cap not reached
    ciStatus: "success",
  };

  const handoffInterpretation = interpretLoopState(snapshot, refinementConfig);
  assert.equal(handoffInterpretation.state, STATE.READY_TO_REREQUEST_REVIEW);
  assert.equal(handoffInterpretation.autoRerequestEligible, true);

  const gateResult = evaluatePrGateCoordination({
    pr: 501,
    currentHeadSha: "cafedeadbeef",
    prDraft: false,
    lifecycleState: handoffInterpretation.state,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    sameHeadCleanConverged: handoffInterpretation.sameHeadCleanConverged,
    ciStatus: snapshot.ciStatus,
    copilotReviewRoundCount: snapshot.copilotReviewRoundCount,
    maxCopilotRounds: refinementConfig.maxCopilotRounds,
    draftGate: gate({ visible: true, headSha: "cafedead", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "cafedead", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(gateResult.nextAction, PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW);
  assert(gateResult.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
  assert(!gateResult.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
});

// #1387 (supersedes the prior #1103/#1126 expectation): at the cap WITH a
// significant post-convergence change, the round cap makes a fresh Copilot
// cycle impossible (request-copilot-review.mjs suppresses the re-request), so
// detect-copilot-loop-state's own ROUND_CAP_CLEAN_FALLBACK nextAction says
// "continue to pre_approval_gate instead of re-requesting Copilot review" —
// evaluatePrGateCoordination must agree, not offer the one impossible action
// while forbidding the one loop-state says to take.
test("interpretLoopState (handoff baseline) and evaluatePrGateCoordination (detect) agree at the cap WITH a significant post-convergence change — pre_approval_gate, not an impossible rerequest (#1387)", () => {
  const refinementConfig = { maxCopilotRounds: 2 };
  const snapshot = {
    prExists: true,
    prNumber: 502,
    copilotReviewRequestStatus: "none",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 2, // == cap
    ciStatus: "success",
  };

  // Same clean-fallback baseline both scripts derive from the snapshot.
  const handoffInterpretation = interpretLoopState(snapshot, refinementConfig);
  assert.equal(handoffInterpretation.state, STATE.ROUND_CAP_CLEAN_FALLBACK);
  assert.match(handoffInterpretation.nextAction, /continue to pre_approval_gate instead of re-requesting/i);

  // detect's path with the shared significant-change signal = true.
  const gateResult = evaluatePrGateCoordination({
    pr: 502,
    currentHeadSha: "beefcafedead",
    prDraft: false,
    lifecycleState: handoffInterpretation.state,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: handoffInterpretation.sameHeadCleanConverged,
    ciStatus: snapshot.ciStatus,
    copilotReviewRoundCount: snapshot.copilotReviewRoundCount,
    maxCopilotRounds: refinementConfig.maxCopilotRounds,
    postConvergenceSignificantChange: true,
    draftGate: gate({ visible: true, headSha: "beefcafe", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "beefcafe", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  // The two detectors must agree: neither dead-ends on the impossible rerequest.
  assert.equal(gateResult.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(gateResult.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!gateResult.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!gateResult.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
});

// Parity (#1165 — in-flight-rerequest race): the SAME snapshot at the cap, clean,
// but with a Copilot review REQUESTED and pending on the CURRENT head (a
// --force-rerequest in flight) plus a significant post-convergence change. Both
// authorities must gate pre_approval_gate until the fresh review lands. This is
// the independent unsettled-review-entry guard (#1190) — orthogonal to #1387's
// round-cap routing fix: an outstanding request on the CURRENT head still
// refuses pre_approval_gate even though the round-cap-clean-fallback branch
// itself now allows it for a significant change with no outstanding request.
//
// Note the interpreter (handoff's base) deliberately routes a pending at-cap
// request to ROUND_CAP_CLEAN_FALLBACK — it cannot see significance (that needs gh
// compare I/O). copilot-pr-handoff.mjs therefore flips this to
// waiting_for_copilot_review when a review is pending on the current head (proven
// by the "in-flight force-rerequest" integration tests). detect's evaluator, fed
// the outstanding copilotReviewRequestStatus, waits for the pending review here.
// Both gate pre-approval — no divergence.
test("interpretLoopState (handoff) and evaluatePrGateCoordination (detect) both gate pre_approval with a pending review + significant change at the cap (#1165)", () => {
  const refinementConfig = { maxCopilotRounds: 2 };
  const snapshot = {
    prExists: true,
    prNumber: 503,
    // Force-rerequest in flight: Copilot review is requested and pending on the current head.
    copilotReviewRequestStatus: "requested",
    copilotReviewPresent: true,
    copilotReviewOnCurrentHead: false,
    unresolvedThreadCount: 0,
    actionableThreadCount: 0,
    copilotReviewRoundCount: 2, // == cap
    ciStatus: "success",
  };

  // handoff's base interpretation: the interpreter ignores the pending at-cap
  // request and resolves the clean fallback. runHandoff flips this to
  // waiting_for_copilot_review (integration tests) so it never proceeds.
  const handoffInterpretation = interpretLoopState(snapshot, refinementConfig);
  assert.equal(handoffInterpretation.state, STATE.ROUND_CAP_CLEAN_FALLBACK);

  // detect's path with the shared significant-change signal = true AND the
  // outstanding review-request status wired through (the independent #1190
  // gate-entry re-check reads this directly, not derived from lifecycleState).
  const gateResult = evaluatePrGateCoordination({
    pr: 503,
    currentHeadSha: "cafef00dbeef",
    prDraft: false,
    lifecycleState: handoffInterpretation.state,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: handoffInterpretation.sameHeadCleanConverged,
    ciStatus: snapshot.ciStatus,
    copilotReviewRoundCount: snapshot.copilotReviewRoundCount,
    maxCopilotRounds: refinementConfig.maxCopilotRounds,
    copilotReviewRequestStatus: snapshot.copilotReviewRequestStatus,
    postConvergenceSignificantChange: true,
    draftGate: gate({ visible: true, headSha: "cafef00", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "cafef00", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  // Both gate pre-approval: detect waits for the outstanding review instead of
  // entering pre_approval_gate; handoff waits for the same pending review.
  assert.equal(gateResult.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW);
  assert(gateResult.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
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

// ---------------------------------------------------------------------------
// Retrospective is advisory (issue #1077, Reading B)
//
// The retrospective NEVER blocks merge or any lifecycle transition. The merge
// gate no longer reads behavioralReview / rawCallViolations / internalToolingOnly;
// those findings travel in the handoff envelope's `retrospectiveFindings` field
// (see handoff-envelope.test.mjs) and an advisory PR comment, not as a gate.
// These tests prove a green PR reaches FINAL_APPROVAL_READY regardless of what
// the retrospective checkpoint records — including non-empty rawCallViolations.
// ---------------------------------------------------------------------------

function advisoryRetroInputs(retrospectiveCheckpoint) {
  return {
    pr: 1077,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "success",
    // The (now-removed) retro config keys and retrospectiveCheckpoint input are
    // ignored by evaluatePrGateCoordination — pass a checkpoint to prove it has
    // no blocking effect.
    retrospectiveCheckpoint,
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
  };
}

function greenRetroBase(overrides = {}) {
  return {
    state: "complete",
    gateQuality: "All gates clean.",
    mergeRecommendation: "Proceed with merge.",
    behavioralReview: {
      mergeApproved: true,
      followedWorkingAgreement: true,
      gateQualityAcceptable: true,
      notes: "All gates clean.",
      drifts: [],
      internalToolingOnly: true,
      rawCallViolations: [],
      ...overrides,
    },
  };
}

function assertAdvisory(result, label) {
  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY, `${label}: gateBoundary`);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL, `${label}: nextAction`);
  assert.notEqual(result.lifecycleState, "retrospective_gate_pending", `${label}: must not produce retrospective_gate_pending`);
  assert.notEqual(result.loopDisposition, DISPOSITION.BLOCKED, `${label}: must not be BLOCKED`);
}

test("retrospective: a missing checkpoint never blocks final approval (#1077)", () => {
  const result = evaluatePrGateCoordination(advisoryRetroInputs(null));
  assertAdvisory(result, "missing checkpoint");
});

test("retrospective: non-empty rawCallViolations never blocks merge or any transition (#1077)", () => {
  const result = evaluatePrGateCoordination(
    advisoryRetroInputs(
      greenRetroBase({
        internalToolingOnly: false,
        rawCallViolations: [
          "gh: gh api repos/x/y/pulls/1/comments",
          "python3: python3 -c 'json.load(...)'",
        ],
      }),
    ),
  );
  assertAdvisory(result, "non-empty rawCallViolations");
  // No lifecycle action is forbidden by the raw-call record: the merge-ready
  // transition (await final human approval) remains allowed.
});

test("retrospective: missing internalToolingOnly / behavioralReview fields never block (#1077)", () => {
  const oldCheckpoint = greenRetroBase();
  delete oldCheckpoint.behavioralReview.internalToolingOnly;
  delete oldCheckpoint.behavioralReview.rawCallViolations;
  const result = evaluatePrGateCoordination(advisoryRetroInputs(oldCheckpoint));
  assertAdvisory(result, "old checkpoint without internal-tooling fields");
});

test("retrospective: missing gateQualityAcceptable / mergeApproved never blocks (#1077)", () => {
  const incomplete = {
    state: "complete",
    mergeRecommendation: "Proceed.",
    behavioralReview: {
      mergeApproved: false,
      followedWorkingAgreement: true,
      notes: "Missing gateQualityAcceptable.",
      drifts: ["No unexpected findings."],
    },
  };
  const result = evaluatePrGateCoordination(advisoryRetroInputs(incomplete));
  assertAdvisory(result, "incomplete behavioralReview");
});

test("retrospective: a clean, merge-approved checkpoint reaches final approval (#1077)", () => {
  const result = evaluatePrGateCoordination(advisoryRetroInputs(greenRetroBase()));
  assertAdvisory(result, "clean checkpoint");
});

test("retrospective: a pending (state=required) checkpoint never blocks (#1077)", () => {
  const result = evaluatePrGateCoordination(
    advisoryRetroInputs({ state: "required", triggeredAt: "2026-07-02T00:00:00.000Z" }),
  );
  assertAdvisory(result, "pending checkpoint");
});

test("retrospective: the removed config keys are ignored — no retrospective_gate_pending under any input (#1077)", () => {
  // Even if a caller passes the (now-removed) requireRetrospectiveGate /
  // requireRetrospectiveInternalTooling flags, the gate is gone and never blocks.
  const result = evaluatePrGateCoordination({
    ...advisoryRetroInputs(
      greenRetroBase({ internalToolingOnly: false, rawCallViolations: ["gh: gh api"] }),
    ),
    requireRetrospectiveGate: true,
    requireRetrospectiveInternalTooling: true,
  });
  assertAdvisory(result, "removed config keys present");
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

test("CONFLICTING mergeable blocks the gate even with clean evidence and no mergeStateStatus/conflictFiles (#980)", () => {
  const result = evaluatePrGateCoordination({
    pr: 980,
    currentHeadSha: "deadbeef1234",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    mergeable: "CONFLICTING",
    draftGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.CONFLICT_RESOLUTION);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS);
  assert.match(result.reason, /mergeable: CONFLICTING/i);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY));
});

test("UNKNOWN mergeable holds the gate for a recheck and never passes (#980)", () => {
  const result = evaluatePrGateCoordination({
    pr: 980,
    currentHeadSha: "deadbeef1234",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    mergeable: "UNKNOWN",
    draftGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.CONFLICT_RESOLUTION);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_CI);
  assert.equal(result.loopDisposition, DISPOSITION.PENDING);
  assert.match(result.reason, /mergeable=UNKNOWN/i);
  // never a pass to final approval
  assert.notEqual(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY));
});

test("MERGEABLE does not block the normal post-draft flow (#980)", () => {
  const result = evaluatePrGateCoordination({
    pr: 980,
    currentHeadSha: "deadbeef1234",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    draftGate: gate({ visible: true, headSha: "deadbee", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "deadbee", verdict: "clean", contractComplete: true }),
  });

  assert.notEqual(result.gateBoundary, PR_CHECKPOINT.CONFLICT_RESOLUTION);
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

test("internal-only PR reaches final approval even with a missing retrospective checkpoint (#1077)", () => {
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
  assert.notEqual(result.lifecycleState, "retrospective_gate_pending");
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

test("internal-only PR reaches final approval regardless of retrospective checkpoint contents (#1077)", () => {
  const result = evaluatePrGateCoordination({
    pr: 298,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    reviewMode: "internal_only",
    // The retrospective checkpoint is no longer read by the merge gate; pass a
    // violation-laden checkpoint to prove it never blocks (advisory, #1077).
    retrospectiveCheckpoint: {
      state: "complete",
      behavioralReview: {
        mergeApproved: false,
        followedWorkingAgreement: false,
        gateQualityAcceptable: false,
        notes: "All gates clean.",
        drifts: ["No unexpected findings."],
        internalToolingOnly: false,
        rawCallViolations: ["gh: gh api repos/x/y"],
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

test("draft PR is not blocked when refinement artifact is present via issue-less PR-body-as-spec", () => {
  const result = evaluatePrGateCoordination({
    pr: 1231,
    currentHeadSha: "abc1234567",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    ciStatus: "success",
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    refinementArtifact: {
      status: "present",
      linkedIssue: null,
      specSource: "pr_body",
      reason: "Refinement artifact present via the PR body itself (issue-less lightweight PR-body-as-spec; validate-pr-body-spec --no-issue clean).",
    },
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
});

test("draft PR blocked reason names the PR-body validation failure, not a linked issue, when refinement artifact is issue-less", () => {
  const result = evaluatePrGateCoordination({
    pr: 1231,
    currentHeadSha: "abc1234567",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    refinementArtifact: {
      status: "missing",
      linkedIssue: null,
      specSource: "pr_body",
      reason: "PR body fails the issue-less lightweight spec-of-record validation (validate-pr-body-spec --no-issue: missing_acceptance_criteria).",
      finding: "missing_refinement_artifact",
    },
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert.match(result.reason, /missing_acceptance_criteria/);
  assert.match(result.reason, /missing_refinement_artifact/);
  assert.doesNotMatch(result.reason, /linked issue/i);
});

test("draft PR blocked reason names the plan-file validation failure, not a linked issue, when refinement artifact is plan-file-backed", () => {
  const result = evaluatePrGateCoordination({
    pr: 1231,
    currentHeadSha: "abc1234567",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    refinementArtifact: {
      status: "missing",
      linkedIssue: null,
      specSource: "plan_file",
      reason: "PR body names the promoted plan doc `docs/phases/phase-9.md` as the spec-of-record but carries no Acceptance criteria / DoD checklist content; a bare marker sentence cannot satisfy the refinement check.",
      finding: "missing_refinement_artifact",
    },
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert.match(result.reason, /docs\/phases\/phase-9\.md/);
  assert.match(result.reason, /missing_refinement_artifact/);
  assert.doesNotMatch(result.reason, /linked issue/i);
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

test("title marker blocks final approval (independent of the removed retrospective gate)", () => {
  const result = evaluatePrGateCoordination({
    pr: 842,
    currentHeadSha: "abc123456789",
    prDraft: false,
    lifecycleState: STATE.PR_READY_NO_FEEDBACK,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    reviewMode: "internal_only",
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

// UI e2e auto-scoping precondition (#976) — path-triggered + fail-closed.
test("UI e2e: rendered-artifact change with passing coverage does not block", () => {
  const result = evaluatePrGateCoordination({
    pr: 11,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    changedFiles: ["docs/presentations/introducing-dev-loops.html"],
    uiE2ePassed: true,
    mergeable: "MERGEABLE",
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });
  assert.notEqual(result.nextAction, PR_CHECKPOINT_ACTION.RUN_UI_E2E_SUITE);
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
});

test("UI e2e: non-UI change is not subject to the precondition", () => {
  const result = evaluatePrGateCoordination({
    pr: 11,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    changedFiles: ["packages/core/src/loop/x.mjs", "README.md"],
    mergeable: "MERGEABLE",
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true }),
  });
  assert.notEqual(result.nextAction, PR_CHECKPOINT_ACTION.RUN_UI_E2E_SUITE);
});

test("UI e2e fail-closed: unregistered rendered artifact blocks the gate", () => {
  const result = evaluatePrGateCoordination({
    pr: 11,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    changedFiles: ["docs/articles/brand-new-page.html"],
    uiE2ePassed: true,
    mergeable: "MERGEABLE",
  });
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_UI_E2E_SUITE);
  assert.equal(result.loopDisposition, DISPOSITION.ACTION_REQUIRED);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
  assert.match(result.reason, /brand-new-page\.html/);
  assert.match(result.reason, /not registered/);
});

test("UI e2e fail-closed: registered artifact without passing coverage blocks", () => {
  const result = evaluatePrGateCoordination({
    pr: 11,
    currentHeadSha: "abc123456789",
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    changedFiles: ["scripts/loop/inspect-run-viewer.mjs"],
    uiE2ePassed: false,
    mergeable: "MERGEABLE",
  });
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_UI_E2E_SUITE);
  assert.match(result.reason, /not passed for this head/);
});

test("preApproval requireCi:false + zero-check CI (none) reaches the pre_approval boundary instead of waiting", () => {
  const result = evaluatePrGateCoordination({
    pr: 1337,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "none",
    preApprovalRequireCi: false,
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });
  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.WAIT_FOR_CI));
});

test("preApproval requireCi default + zero-check CI (none) still waits on CI", () => {
  const result = evaluatePrGateCoordination({
    pr: 1337,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "none",
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });
  assert.equal(result.lifecycleState, STATE.WAITING_FOR_CI);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_CI);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.WAIT_FOR_CI));
});

test("preApproval requireCi:false ignores a real CI failure at the pre_approval boundary", () => {
  const result = evaluatePrGateCoordination({
    pr: 1337,
    currentHeadSha: "fedcba987654",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true,
    ciStatus: "failure",
    preApprovalRequireCi: false,
    draftGate: gate({ visible: true, headSha: "fedcba9", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "fedcba9", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });
  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert.notEqual(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
});

// #1472: ROUND_CAP_REACHED is a compound "unresolved threads OR non-clean CI"
// hard stop with no dedicated boundary of its own. When a caller independently
// affirms zero unresolved threads and green CI on the current head — exactly
// the conditions buildRoundExhaustionGateEvidenceNote's own text promises — the
// evaluator must recommend run_pre_approval_gate AND grant it in
// allowedNextActions (never just forbiddenActions-silent), matching the
// nextAction/allowedNextActions/forbiddenActions agreement upsert-checkpoint-
// verdict.mjs (which validates against allowedNextActions/forbiddenActions,
// not nextAction) relies on.
test("round_cap_reached with zero unresolved threads and green CI allows run_pre_approval_gate (#1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "success",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    unresolvedThreadCount: 0,
    draftGate: gate({ visible: true, headSha: "7e0e303b", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "7e0e303b", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  // Mirrors upsert-checkpoint-verdict.mjs's gate-entry validation exactly:
  // `gateActionForbidden = coordination.forbiddenActions.includes(requestedGateAction)`.
  assert.equal(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE), false);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
  assert.equal(result.draftGateAlreadySatisfied, true);
  assert.match(result.reason, /round limit is exhausted/i);
  assert.ok(result.gateEvidenceNote);
  assert.match(result.gateEvidenceNote, /zero unresolved threads/i);
});

// #1472 defer: when preApprovalRequireCi is false, ciConfirmedGreen is true
// regardless of the actual CI status, so a "failure" head can still reach this
// grant. The reason/gateEvidenceNote must not claim the CI is green in that
// case (a false claim in human-read gate evidence) — they must instead say CI
// was not required.
test("round_cap_reached with requireCi:false and failing CI grants run_pre_approval_gate without claiming green CI (#1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "failure",
    preApprovalRequireCi: false,
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    unresolvedThreadCount: 0,
    draftGate: gate({ visible: true, headSha: "7e0e303b", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "7e0e303b", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert.doesNotMatch(result.reason, /green CI/i);
  assert.match(result.reason, /CI not required by config/i);
  assert.ok(result.gateEvidenceNote);
  assert.doesNotMatch(result.gateEvidenceNote, /green.{0,20}CI/i);
  assert.match(result.gateEvidenceNote, /CI not required by config/i);
});

// #1371 re-verify: crediblyGreen is unconfirmed CI and stays blocked at the
// round-cap-reached fallback exactly as it does at every other pre-approval
// boundary in this file (lines ~1016/1219/1404/1655) — this branch must not
// be the one place a crediblyGreen head is granted gate entry.
test("round_cap_reached with zero unresolved threads and credibly green CI stays blocked (#1371, #1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "crediblyGreen",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    unresolvedThreadCount: 0,
    draftGate: gate({ visible: true, headSha: "7e0e303b", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "7e0e303b", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REPORT_BLOCKED));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("round_cap_reached with clean current-head pre_approval AND clean draft_gate evidence reaches final approval (#1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "success",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    unresolvedThreadCount: 0,
    draftGate: gate({ visible: true, headSha: "7e0e303b", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "7e0e303b", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "29aa40b7", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "29aa40b7", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
  assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
});

// #579/#1472: mirrors "round_cap_clean_fallback with clean pre_approval but no
// draft_gate evidence reconciles the draft gate" for the ROUND_CAP_REACHED
// grant — a clean current head with no clean draft_gate evidence must
// reconcile the draft gate, NOT jump to final approval (#579 no gate
// exemptions). Pins the `!draftGate.cleanEvidenceExists` sub-branch: deleting
// it flips this exact shape from draft_gate_needed/reconcile_draft_gate to
// final_approval_ready/await_final_human_approval undetected.
test("round_cap_reached with clean current-head pre_approval but no draft_gate evidence reconciles the draft gate (#579, #1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "success",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    unresolvedThreadCount: 0,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: true, headSha: "29aa40b7", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "29aa40b7", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_GATE_NEEDED);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE);
  assert.equal(result.draftGate.cleanEvidenceExists, false);
  assert.equal(result.draftGateAlreadySatisfied, false);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
  assert.match(result.reason, /no gate exemptions, #579/i);
});

// Same shape with a blocking title marker: DRAFT_GATE_NEEDED is NOT in
// TITLE_MARKER_GUARDED_BOUNDARIES, so the outer post-pass cannot re-block this
// sub-path — the grant block's inline check (mirroring ROUND_CAP_CLEAN_FALLBACK)
// must. Fails without it: the WIP head routes to reconcile_draft_gate.
test("round_cap_reached grant shape with a WIP title blocks on the title marker, not reconcile_draft_gate (#842, #1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    prTitle: "WIP: do not merge yet",
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "success",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    unresolvedThreadCount: 0,
    draftGate: gate({ visible: false }),
    draftGateMarker: gate({ visible: false }),
    preApprovalGate: gate({ visible: true, headSha: "29aa40b7", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "29aa40b7", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.lifecycleState, "title_marker_blocked");
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.notEqual(result.gateBoundary, PR_CHECKPOINT.DRAFT_GATE_NEEDED);
  assert(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE));
});

// #1472: applyUnsettledCopilotReviewEntryGuard (the core-side #1190 mirror of
// the detector's formal-request guard) runs unconditionally after the
// evaluator's own ROUND_CAP_REACHED grant, on the SAME input this evaluator
// call receives. A lingering requested/already-requested Copilot review
// status on a post-cap head is for a review that can never come (no further
// round is permitted), so — same as ROUND_CAP_CLEAN_FALLBACK — it must not
// re-block this grant. Fails pre-fix: without widening this guard's exemption
// with isRoundCapReachedCleanGrant, both statuses get rewritten to
// waiting_for_copilot_review, dead-ending the loop.
for (const copilotReviewRequestStatus of ["requested", "already-requested"]) {
  test(`round_cap_reached + pre_approval_gate_window grant survives a lingering copilotReviewRequestStatus:${copilotReviewRequestStatus} (#1472)`, () => {
    const result = evaluatePrGateCoordination({
      pr: 1460,
      currentHeadSha: "29aa40b7deadbeef",
      prDraft: false,
      lifecycleState: STATE.ROUND_CAP_REACHED,
      loopDisposition: DISPOSITION.BLOCKED,
      ciStatus: "success",
      copilotReviewRoundCount: 2,
      maxCopilotRounds: 2,
      unresolvedThreadCount: 0,
      copilotReviewRequestStatus,
      draftGate: gate({ visible: true, headSha: "7e0e303b", verdict: "clean" }),
      draftGateMarker: gate({ visible: true, headSha: "7e0e303b", verdict: "clean", contractComplete: true }),
      preApprovalGate: gate({ visible: false }),
      preApprovalGateMarker: gate({ visible: false }),
    });

    assert.equal(result.gateBoundary, PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW);
    assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
    assert(!result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  });
}

// #1472 control: the round-cap exemption above is scoped to the grant's own
// shape (gateBoundary pre_approval_gate_window) via isRoundCapReachedCleanGrant
// — it must NOT blanket-exempt every round_cap_reached result. When the same
// facts instead reach FINAL_APPROVAL_READY (preApprovalGate already clean on
// the current head), a lingering review request is still a genuinely unsettled
// signal and the guard must still fire.
test("round_cap_reached reaching final_approval_ready (not the window shape) still guards a lingering copilotReviewRequestStatus:requested (#1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "success",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    unresolvedThreadCount: 0,
    copilotReviewRequestStatus: "requested",
    draftGate: gate({ visible: true, headSha: "7e0e303b", verdict: "clean" }),
    draftGateMarker: gate({ visible: true, headSha: "7e0e303b", verdict: "clean", contractComplete: true }),
    preApprovalGate: gate({ visible: true, headSha: "29aa40b7", verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: "29aa40b7", verdict: "clean", contractComplete: true }),
  });

  assert.equal(result.gateBoundary, PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW);
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));
});

test("round_cap_reached with unresolved threads present stays blocked exactly as today (#1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "success",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    unresolvedThreadCount: 1,
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REPORT_BLOCKED));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("round_cap_reached with non-green CI stays blocked exactly as today even with zero unresolved threads (#1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "failure",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    unresolvedThreadCount: 0,
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REPORT_BLOCKED));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("round_cap_reached with an unknown unresolved-thread count fails closed and stays blocked (#1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "success",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    // unresolvedThreadCount intentionally omitted — unknown must not be
    // coerced to "clean".
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REPORT_BLOCKED));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("round_cap_reached with a non-integer unresolved-thread count fails closed and stays blocked (#1472)", () => {
  const result = evaluatePrGateCoordination({
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prDraft: false,
    lifecycleState: STATE.ROUND_CAP_REACHED,
    loopDisposition: DISPOSITION.BLOCKED,
    ciStatus: "success",
    copilotReviewRoundCount: 2,
    maxCopilotRounds: 2,
    // A fractional count must be treated as unknown (null), never floored to
    // 0 — flooring would satisfy the grant's zero-threads precondition.
    unresolvedThreadCount: 0.5,
    preApprovalGate: gate({ visible: false }),
    preApprovalGateMarker: gate({ visible: false }),
  });

  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert(result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REPORT_BLOCKED));
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

// #1472 reachability: the ROUND_CAP_REACHED grant branch above is a defensive
// gate-entry re-check, not a path the interpreter's own routing is expected to
// take. Prove the equivalence the branch's comment claims: for every
// combination of facts where the evaluator's branch would grant gate entry
// (zero unresolved threads, CI predicate satisfied), copilot-loop-state's
// interpreter — fed the SAME facts at the SAME round cap — already classifies
// the snapshot as ROUND_CAP_CLEAN_FALLBACK, never ROUND_CAP_REACHED. So the
// branch's guard (effectiveLifecycleState === ROUND_CAP_REACHED) and its own
// grant condition can never both be true from facts a real caller reads
// straight off the interpreter; the two predicates cannot silently drift
// apart without this test catching it.
test("round_cap_reached grant branch and copilot-loop-state's round-cap fallback agree on identical facts (#1472)", () => {
  const ciStatuses = ["success", "failure", "pending", "none", "crediblyGreen"];
  const requireCiOptions = [true, false];
  const threadCounts = [0, 1, 3];
  const roundCap = { copilotReviewRoundCount: 5, maxCopilotRounds: 5 };

  let checked = 0;
  let grantedCount = 0;
  for (const ciStatus of ciStatuses) {
    for (const preApprovalRequireCi of requireCiOptions) {
      for (const unresolvedThreadCount of threadCounts) {
        checked += 1;
        const evaluated = evaluatePrGateCoordination({
          pr: 1472,
          currentHeadSha: "29aa40b7deadbeef",
          prDraft: false,
          lifecycleState: STATE.ROUND_CAP_REACHED,
          loopDisposition: DISPOSITION.BLOCKED,
          ciStatus,
          preApprovalRequireCi,
          ...roundCap,
          unresolvedThreadCount,
          preApprovalGate: gate({ visible: false }),
          preApprovalGateMarker: gate({ visible: false }),
        });
        const granted = evaluated.nextAction === PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE
          || evaluated.nextAction === PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL;
        if (granted) grantedCount += 1;

        const interpreted = interpretLoopState({
          prExists: true,
          prNumber: 1472,
          copilotReviewRequestStatus: "none",
          copilotReviewPresent: true,
          copilotReviewOnCurrentHead: false,
          unresolvedThreadCount,
          actionableThreadCount: unresolvedThreadCount,
          ...roundCap,
          ciStatus,
        }, { maxCopilotRounds: roundCap.maxCopilotRounds, preApprovalRequireCi });

        const context = JSON.stringify({ ciStatus, preApprovalRequireCi, unresolvedThreadCount });
        if (granted) {
          assert.equal(
            interpreted.state,
            STATE.ROUND_CAP_CLEAN_FALLBACK,
            `evaluator granted gate entry but interpreter did not classify identical facts as round_cap_clean_fallback for ${context}`,
          );
        }
        if (interpreted.state === STATE.ROUND_CAP_REACHED) {
          assert.equal(
            granted,
            false,
            `interpreter hard-stopped at round_cap_reached but the evaluator granted gate entry on identical facts for ${context}`,
          );
        }
      }
    }
  }
  assert.ok(checked > 0);
  // #1472 (round-2 sweep defer, closed here): a vacuous sweep (e.g. the grant
  // becoming unreachable) would still pass every assertion above — pin that
  // at least one fact combination actually grants, so a future change that
  // silently makes the grant unreachable fails this test.
  assert.ok(grantedCount > 0, "sweep never exercised a granted case — the round_cap_reached grant may have become unreachable");
});

// #1472: general contract invariant, across every lifecycle state the
// evaluator can be handed and a broad sweep of companion signals — the
// synthesized nextAction must always be a member of allowedNextActions and
// never a member of forbiddenActions. Forward-drift guard: no committed
// evaluator version violates this matrix (the pre-fix round_cap_reached shape
// returned a self-consistent report_blocked), but a future return statement
// naming a nextAction without granting it in allowedNextActions (or while
// forbidding it) is exactly the shape upsert-checkpoint-verdict.mjs cannot
// act on, so the sweep pins the invariant against regression.
test("contract: nextAction is always allowed and never forbidden, across every lifecycle state (#1472)", () => {
  const lifecycleStates = Object.values(STATE);
  const ciStatuses = ["success", "failure", "pending", "none", "crediblyGreen"];
  const draftGateFixtures = [
    gate({ visible: false }),
    gate({ visible: true, headSha: "abc12345", verdict: "clean" }),
  ];
  const preApprovalGateFixtures = [
    gate({ visible: false }),
    gate({ visible: true, headSha: "abc12345", verdict: "clean" }),
  ];
  const unresolvedThreadCounts = [0, 1, undefined];
  const prDrafts = [true, false];
  const roundCapCombos = [
    { copilotReviewRoundCount: 0, maxCopilotRounds: 5 },
    { copilotReviewRoundCount: 5, maxCopilotRounds: 5 },
  ];

  let checked = 0;
  for (const lifecycleState of lifecycleStates) {
    for (const ciStatus of ciStatuses) {
      for (const draftGateFixture of draftGateFixtures) {
        for (const preApprovalGateFixture of preApprovalGateFixtures) {
          for (const unresolvedThreadCount of unresolvedThreadCounts) {
            for (const prDraft of prDrafts) {
              for (const { copilotReviewRoundCount, maxCopilotRounds } of roundCapCombos) {
                const result = evaluatePrGateCoordination({
                  pr: 1,
                  currentHeadSha: "abc123456789",
                  prDraft,
                  lifecycleState,
                  ciStatus,
                  copilotReviewRoundCount,
                  maxCopilotRounds,
                  unresolvedThreadCount,
                  draftGate: draftGateFixture,
                  draftGateMarker: draftGateFixture.visible
                    ? { ...draftGateFixture, contractComplete: true }
                    : draftGateFixture,
                  preApprovalGate: preApprovalGateFixture,
                  preApprovalGateMarker: preApprovalGateFixture.visible
                    ? { ...preApprovalGateFixture, contractComplete: true }
                    : preApprovalGateFixture,
                });
                checked += 1;
                const context = JSON.stringify({ lifecycleState, ciStatus, unresolvedThreadCount, prDraft, copilotReviewRoundCount, maxCopilotRounds });
                assert.ok(
                  result.allowedNextActions.includes(result.nextAction),
                  `nextAction "${result.nextAction}" missing from allowedNextActions for ${context}`,
                );
                assert.ok(
                  !result.forbiddenActions.includes(result.nextAction),
                  `nextAction "${result.nextAction}" present in forbiddenActions for ${context}`,
                );
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 0);
});
