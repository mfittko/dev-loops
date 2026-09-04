import assert from "node:assert/strict";
import test from "node:test";

import { SUBMITTED_REVIEW_STATES, summarizeCopilotReviews } from "../src/github/copilot-helpers.mjs";
import { summarizeCopilotLoopIterations } from "../src/loop/copilot-loop-iterations.mjs";
import { normalizeReviewerSnapshot } from "../src/loop/reviewer-loop-state.mjs";

// The submitted-review-state whitelist has one canonical declaration
// (copilot-helpers). The two importing loop modules and copilot-helpers' own
// summarizer must all consume THAT set: a state added to it becomes observable
// at each, which a drifted private copy would not show.
test("the canonical SUBMITTED_REVIEW_STATES drives the three core call sites", (t) => {
  assert.deepEqual([...SUBMITTED_REVIEW_STATES].sort(), ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

  SUBMITTED_REVIEW_STATES.add("AGREEMENT_PROBE");
  t.after(() => SUBMITTED_REVIEW_STATES.delete("AGREEMENT_PROBE"));

  // reviewer-loop-state: the probe state normalizes instead of nulling out.
  const snapshot = normalizeReviewerSnapshot({
    prExists: true,
    prNumber: 1,
    submittedReviewState: "agreement_probe",
  });
  assert.equal(snapshot.submittedReviewState, "AGREEMENT_PROBE");

  // copilot-loop-iterations: a review in the probe state counts as submitted.
  const summary = summarizeCopilotLoopIterations({
    reviewRequestEvents: [
      { createdAt: "2026-05-01T09:59:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
    ],
    reviews: [
      { state: "AGREEMENT_PROBE", submittedAt: "2026-05-01T10:05:00Z", authorLogin: "copilot-pull-request-reviewer[bot]", commitSha: "sha-1" },
    ],
    reviewComments: [],
    commits: [],
    reviewThreadSummary: {},
  });
  assert.equal(summary.completedCopilotReviewRounds, 1);

  // copilot-helpers' summarizer: pins that it keeps consuming the canonical
  // set rather than growing back a private copy of its own.
  const helperSummary = summarizeCopilotReviews([
    { state: "AGREEMENT_PROBE", submittedAt: "2026-05-01T10:05:00Z", author: { login: "copilot-pull-request-reviewer[bot]" }, commit: { oid: "sha-1" } },
  ], { headSha: "sha-1" });
  assert.equal(helperSummary.completedCopilotReviewRounds, 1);
  assert.equal(helperSummary.hasSubmittedReviewOnCurrentHead, true);
});

// The fourth consumer, scripts/loop/detect-reviewer-loop-state.mjs, is pinned
// behaviorally in its own suite (test/loop/detect-reviewer-loop-state.test.mjs:
// "counts only canonical submitted-review states").
