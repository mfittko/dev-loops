import assert from "node:assert/strict";
import { test } from "bun:test";

import { deriveInboxSignalFromSnapshot, summarizeCurrentPrStatus } from "../../scripts/loop/inspect-run-viewer/status.mjs";

function staleReviewSnapshot() {
  return {
    ok: true,
    outerState: "continue_current_wait",
    outerAction: "continue_wait",
    lifecyclePhase: "unknown",
    lifecycleAllowedTransitions: [],
    layers: {
      copilot: { currentState: "pr_ready_no_feedback" },
      reviewer: { currentState: "re_review_needed", submittedReviewState: "COMMENTED", approvedOnCurrentHead: false },
    },
  };
}

test("summarizeCurrentPrStatus surfaces re_review_needed as a re-review headline", () => {
  const summary = summarizeCurrentPrStatus(staleReviewSnapshot());
  assert.equal(summary.headline, "Re-review needed");
  assert.equal(summary.detail, "The latest submitted review predates the current head commit.");
  assert.equal(summary.nextAction, "Request a fresh review on the current head.");
});

test("deriveInboxSignalFromSnapshot classifies re_review_needed as waiting", () => {
  assert.equal(deriveInboxSignalFromSnapshot(staleReviewSnapshot()), "waiting");
});
