import assert from "node:assert/strict";
import { test } from "bun:test";

import { STATE as COPILOT_STATE } from "../../packages/core/src/loop/copilot-loop-state.mjs";
import { REVIEWER_STATE } from "../../packages/core/src/loop/reviewer-loop-state.mjs";
import { OUTER_STATE } from "../../packages/core/src/loop/conductor-routing.mjs";
import {
  deriveInboxSignalFromSnapshot,
  renderLoopIterationMetrics,
  summarizeCurrentPrStatus,
} from "../../scripts/loop/inspect-run-viewer/status.mjs";

// A lane-level headline means the viewer had nothing specific to say about the
// state it was handed. That is allowed only as a true last resort, never for a
// state the loop vocabulary actually defines.
const LANE_LEVEL_HEADLINES = new Set([
  "Copilot lane is next",
  "Reviewer lane is next",
]);

function snapshotWith({ copilotState, reviewerState, outerState, outerAction, ...rest }) {
  return {
    ok: true,
    target: { repo: "owner/repo", pr: 55 },
    outerState,
    outerAction,
    statusClass: "active",
    needsAttention: false,
    sourceMode: "live-detector-backed",
    trust: "authoritative",
    loopIterations: { available: false, source: "github_pr_timeline", reason: "requires_live_github_facts" },
    layers: {
      copilot: { currentState: copilotState, allowedTransitions: [] },
      reviewer: { currentState: reviewerState, scope: { mode: "all_reviewers", reviewerLogin: null }, allowedTransitions: [] },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
    ...rest,
  };
}

test("every copilot loop state has state-specific viewer copy", () => {
  const generic = [];
  for (const copilotState of Object.values(COPILOT_STATE)) {
    const summary = summarizeCurrentPrStatus(snapshotWith({
      copilotState,
      reviewerState: REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST,
      outerState: OUTER_STATE.HANDOFF_TO_COPILOT_LOOP,
      outerAction: "reenter_copilot_loop",
    }));
    if (LANE_LEVEL_HEADLINES.has(summary.headline)) {
      generic.push(copilotState);
    }
  }
  assert.deepEqual(generic, [], `copilot states with no specific viewer copy: ${generic.join(", ")}`);
});

test("every reviewer loop state has state-specific viewer copy", () => {
  const generic = [];
  for (const reviewerState of Object.values(REVIEWER_STATE)) {
    const summary = summarizeCurrentPrStatus(snapshotWith({
      // A copilot state with no opinion of its own, so the reviewer lane decides.
      copilotState: "waiting_for_ci",
      reviewerState,
      outerState: OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP,
      outerAction: "reenter_reviewer_loop",
    }));
    if (LANE_LEVEL_HEADLINES.has(summary.headline)) {
      generic.push(reviewerState);
    }
  }
  assert.deepEqual(generic, [], `reviewer states with no specific viewer copy: ${generic.join(", ")}`);
});

test("no state claims a requested follow-up without a review request on record", () => {
  const offenders = [];
  for (const copilotState of Object.values(COPILOT_STATE)) {
    for (const reviewerState of Object.values(REVIEWER_STATE)) {
      const summary = summarizeCurrentPrStatus(snapshotWith({
        copilotState,
        reviewerState,
        outerState: OUTER_STATE.HANDOFF_TO_COPILOT_LOOP,
        outerAction: "reenter_copilot_loop",
      }));
      if (/requested follow-up/i.test(`${summary.detail} ${summary.nextAction}`)) {
        offenders.push(`${copilotState}/${reviewerState}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `states asserting a phantom requested follow-up: ${offenders.slice(0, 5).join(", ")}`);
});

test("a lane fall-back quotes the routing layer's own reason when one exists", () => {
  const routingReason = "PR is in draft state; copilot loop required: copilot_state=some_future_state";
  const summary = summarizeCurrentPrStatus(snapshotWith({
    // A state this viewer has no copy for is exactly when the fall-back runs.
    copilotState: "some_future_state",
    // Both lanes must be states the viewer has no copy for, otherwise a
    // lane-specific branch answers before the fall-back is reached.
    reviewerState: "some_future_reviewer_state",
    outerState: OUTER_STATE.HANDOFF_TO_COPILOT_LOOP,
    outerAction: "reenter_copilot_loop",
    outerHandoffReason: routingReason,
  }));

  assert.equal(summary.headline, "Copilot lane is next");
  assert.equal(summary.detail, routingReason, "the fall-back must quote routing, not invent prose");
});

test("the triage signal is labelled so it cannot be read as the needsAttention flag", () => {
  // Same snapshot: triage says attention (a handoff is pending), the blocking
  // flag says false. Both are true statements about different things.
  const snapshot = snapshotWith({
    copilotState: COPILOT_STATE.PR_DRAFT,
    reviewerState: REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST,
    outerState: OUTER_STATE.HANDOFF_TO_COPILOT_LOOP,
    outerAction: "reenter_copilot_loop",
  });
  assert.equal(deriveInboxSignalFromSnapshot(snapshot), "attention");
  assert.equal(snapshot.needsAttention, false);

  const summary = summarizeCurrentPrStatus(snapshot);
  assert.equal(summary.headline, "Draft PR; no review requested yet");
  assert.doesNotMatch(summary.nextAction, /requested follow-up/i);
});

test("unavailable round metrics say which kind of unavailable they are", () => {
  const noRounds = renderLoopIterationMetrics({ available: false, reason: "requires_live_github_facts" });
  assert.match(noRounds, /No Copilot round on record/);
  assert.doesNotMatch(noRounds, /not present/);

  const failed = renderLoopIterationMetrics({ available: false, reason: "github_fact_capture_failed" });
  assert.match(failed, /could not be read from GitHub/);

  const noPr = renderLoopIterationMetrics({ available: false, reason: "no_pr" });
  assert.match(noPr, /No pull request yet/);

  const unknownReason = renderLoopIterationMetrics({ available: false, reason: "brand_new_reason" });
  assert.match(unknownReason, /Round metrics unavailable \(brand new reason\)/);

  const deferred = renderLoopIterationMetrics({ available: false, reason: "deferred_by_caller" });
  assert.match(deferred, /Loading round metrics/);

  const present = renderLoopIterationMetrics({ available: true, completedCopilotReviewRounds: 2 });
  assert.match(present, /completed rounds/);
});
