import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEWER_STATE,
  REVIEWER_TRANSITIONS,
  normalizeReviewerSnapshot,
  interpretReviewerLoopState,
  REVIEWER_SUPPORTED_ANGLES,
  selectReviewerPlan,
  mergeReviewerResults,
  buildDraftReviewPayload,
} from "../src/loop/reviewer-loop-state.mjs";

test("normalizeReviewerSnapshot rejects non-object input", () => {
  assert.throws(() => normalizeReviewerSnapshot(null), /Snapshot must be a non-null object/);
  assert.throws(() => normalizeReviewerSnapshot(undefined), /Snapshot must be a non-null object/);
});

test("normalizeReviewerSnapshot returns deterministic defaults", () => {
  const result = normalizeReviewerSnapshot({});
  assert.deepEqual(result, {
    prExists: false,
    prNumber: null,
    prDraft: false,
    prMerged: false,
    prClosed: false,
    prHeadSha: null,
    reviewerScope: "all_reviewers",
    reviewerLogin: null,
    reviewRequested: false,
    localPlanningStatus: "none",
    localReviewRunsStatus: "none",
    localMergeStatus: "none",
    draftReviewPrepared: false,
    draftReviewPosted: false,
    draftReviewId: null,
    draftReviewUrl: null,
    draftReviewCommitSha: null,
    draftReviewNotificationStatus: "none",
    submittedReviewPresent: false,
    submittedReviewCommitSha: null,
    submittedReviewState: null,
    reviewSubmissionStatus: "none",
  });
});

test("normalizeReviewerSnapshot derives reviewer scope metadata deterministically", () => {
  assert.deepEqual(
    normalizeReviewerSnapshot({ reviewerLogin: "Pi-Reviewer" }),
    {
      ...normalizeReviewerSnapshot({}),
      reviewerScope: "single_reviewer",
      reviewerLogin: "pi-reviewer",
    },
  );

  assert.deepEqual(
    normalizeReviewerSnapshot({ reviewerScope: "single_reviewer" }),
    {
      ...normalizeReviewerSnapshot({}),
      reviewerScope: "all_reviewers",
      reviewerLogin: null,
    },
  );
});

test("normalizeReviewerSnapshot canonicalizes submittedReviewState and drops unknown values", () => {
  assert.equal(
    normalizeReviewerSnapshot({ submittedReviewState: " approved " }).submittedReviewState,
    "APPROVED",
  );

  assert.equal(
    normalizeReviewerSnapshot({ submittedReviewState: "cHaNgEs_ReQuEsTeD" }).submittedReviewState,
    "CHANGES_REQUESTED",
  );

  assert.equal(
    normalizeReviewerSnapshot({ submittedReviewState: "needs-work" }).submittedReviewState,
    null,
  );
});

test("REVIEWER_TRANSITIONS covers every REVIEWER_STATE", () => {
  const valid = new Set(Object.values(REVIEWER_STATE));
  for (const state of valid) {
    assert.ok(Object.prototype.hasOwnProperty.call(REVIEWER_TRANSITIONS, state), `missing transition entry for ${state}`);
  }
  for (const [from, targets] of Object.entries(REVIEWER_TRANSITIONS)) {
    assert.ok(valid.has(from));
    for (const target of targets) {
      assert.ok(valid.has(target), `${from} -> ${target} must reference a known state`);
    }
  }
});

test("interpretReviewerLoopState distinguishes planning, running, and merge stages", () => {
  const planning = interpretReviewerLoopState({ prExists: true, prNumber: 17, reviewRequested: true, localPlanningStatus: "determining" });
  assert.equal(planning.state, REVIEWER_STATE.DETERMINE_REVIEW_PLAN);

  const running = interpretReviewerLoopState({ prExists: true, prNumber: 17, reviewRequested: true, localReviewRunsStatus: "running" });
  assert.equal(running.state, REVIEWER_STATE.REVIEWS_RUNNING);

  const merge = interpretReviewerLoopState({ prExists: true, prNumber: 17, reviewRequested: true, localReviewRunsStatus: "completed" });
  assert.equal(merge.state, REVIEWER_STATE.MERGE_RESULTS);
});

test("interpretReviewerLoopState distinguishes draft prepared, posted, submitted, and invalidated", () => {
  const ready = interpretReviewerLoopState({ prExists: true, prNumber: 17, draftReviewPrepared: true });
  assert.equal(ready.state, REVIEWER_STATE.DRAFT_REVIEW_READY);

  const posted = interpretReviewerLoopState({
    prExists: true,
    prNumber: 17,
    prHeadSha: "abc",
    draftReviewPosted: true,
    draftReviewCommitSha: "abc",
  });
  assert.equal(posted.state, REVIEWER_STATE.DRAFT_REVIEW_POSTED);

  const waitingSubmit = interpretReviewerLoopState({
    prExists: true,
    prNumber: 17,
    prHeadSha: "abc",
    draftReviewPosted: true,
    draftReviewCommitSha: "abc",
    draftReviewNotificationStatus: "notified",
  });
  assert.equal(waitingSubmit.state, REVIEWER_STATE.WAITING_FOR_USER_SUBMIT);

  const invalidated = interpretReviewerLoopState({
    prExists: true,
    prNumber: 17,
    prHeadSha: "def",
    draftReviewPosted: true,
    draftReviewCommitSha: "abc",
  });
  assert.equal(invalidated.state, REVIEWER_STATE.REVIEW_INVALIDATED);

  const submitted = interpretReviewerLoopState({
    prExists: true,
    prNumber: 17,
    reviewSubmissionStatus: "submitted",
  });
  assert.equal(submitted.state, REVIEWER_STATE.SUBMITTED_REVIEW);
});


test("interpretReviewerLoopState keeps a fresh pending draft ahead of historical submitted review state", () => {
  const result = interpretReviewerLoopState({
    prExists: true,
    prNumber: 17,
    prHeadSha: "new",
    draftReviewPosted: true,
    draftReviewCommitSha: "new",
    draftReviewNotificationStatus: "notified",
    submittedReviewPresent: true,
    submittedReviewCommitSha: "old",
  });

  assert.equal(result.state, REVIEWER_STATE.WAITING_FOR_USER_SUBMIT);
});


test("interpretReviewerLoopState lets current PR closure outrank stale local reviewer metadata", () => {
  const merged = interpretReviewerLoopState({
    prExists: true,
    prNumber: 17,
    prMerged: true,
    reviewSubmissionStatus: "submitted",
    draftReviewPrepared: true,
  });
  assert.equal(merged.state, REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST);

  const submittedWinsOverPrepared = interpretReviewerLoopState({
    prExists: true,
    prNumber: 17,
    prHeadSha: "def",
    submittedReviewPresent: true,
    submittedReviewCommitSha: "abc",
    draftReviewPrepared: true,
    reviewRequested: false,
  });
  assert.equal(submittedWinsOverPrepared.state, REVIEWER_STATE.SUBMITTED_REVIEW);
});

test("interpretReviewerLoopState treats submitted review as handoff and starts new pass on explicit re-request", () => {
  const submittedAtSameHead = interpretReviewerLoopState({
    prExists: true,
    prNumber: 17,
    prHeadSha: "abc",
    submittedReviewPresent: true,
    submittedReviewCommitSha: "abc",
  });
  assert.equal(submittedAtSameHead.state, REVIEWER_STATE.SUBMITTED_REVIEW);

  const submittedAfterAuthorPush = interpretReviewerLoopState({
    prExists: true,
    prNumber: 17,
    prHeadSha: "def",
    submittedReviewPresent: true,
    submittedReviewCommitSha: "abc",
    reviewRequested: false,
  });
  assert.equal(submittedAfterAuthorPush.state, REVIEWER_STATE.SUBMITTED_REVIEW);

  const rerequested = interpretReviewerLoopState({
    prExists: true,
    prNumber: 17,
    prHeadSha: "def",
    submittedReviewPresent: true,
    submittedReviewCommitSha: "abc",
    reviewRequested: true,
  });
  assert.equal(rerequested.state, REVIEWER_STATE.REVIEW_REQUESTED);
});

test("interpretReviewerLoopState routes failures to blocked_needs_user_decision", () => {
  for (const snapshot of [
    { prExists: true, prNumber: 1, localPlanningStatus: "failed" },
    { prExists: true, prNumber: 1, localReviewRunsStatus: "failed" },
    { prExists: true, prNumber: 1, localMergeStatus: "failed" },
    { prExists: true, prNumber: 1, reviewSubmissionStatus: "failed" },
  ]) {
    const result = interpretReviewerLoopState(snapshot);
    assert.equal(result.state, REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION);
    assert.deepEqual(result.allowedTransitions, []);
  }
});

// #1200: reviewSubmissionStatus:"failed" on draft_review_posted/waiting_for_user_submit-shaped
// snapshots must fail closed too, and REVIEWER_TRANSITIONS must declare those edges so the
// interpreter's output stays reachable via the declared graph (see property test below).
test("interpretReviewerLoopState fails closed on submission failure from posted/waiting-submit shapes", () => {
  const posted = interpretReviewerLoopState({
    prExists: true,
    prNumber: 1,
    prHeadSha: "abc",
    draftReviewPosted: true,
    draftReviewCommitSha: "abc",
    reviewSubmissionStatus: "failed",
  });
  assert.equal(posted.state, REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.ok(REVIEWER_TRANSITIONS[REVIEWER_STATE.DRAFT_REVIEW_POSTED].includes(REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION));

  const waitingSubmit = interpretReviewerLoopState({
    prExists: true,
    prNumber: 1,
    prHeadSha: "abc",
    draftReviewPosted: true,
    draftReviewCommitSha: "abc",
    draftReviewNotificationStatus: "notified",
    reviewSubmissionStatus: "failed",
  });
  assert.equal(waitingSubmit.state, REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.ok(REVIEWER_TRANSITIONS[REVIEWER_STATE.WAITING_FOR_USER_SUBMIT].includes(REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION));
});

// The broader "every REVIEWER_TRANSITIONS-declared edge is exercised by a real fixture"
// property test lives in test/docs/validate-state-machine-conformance.test.mjs (the
// registered "reviewer-loop-state" machine's completeness/liveness/conformance/safety
// report), which now covers the two edges added above; no need to duplicate that machinery
// here.

test("selectReviewerPlan keeps bounded deterministic angles", () => {
  assert.ok(Array.isArray(REVIEWER_SUPPORTED_ANGLES));
  assert.ok(REVIEWER_SUPPORTED_ANGLES.includes("security"));

  const defaultPlan = selectReviewerPlan();
  assert.equal(defaultPlan.maxParallel, 3);
  assert.equal(defaultPlan.angles.length, 3);
  assert.deepEqual(defaultPlan.runs.map((run) => run.runId), [
    "review-angle-01",
    "review-angle-02",
    "review-angle-03",
  ]);

  const custom = selectReviewerPlan({
    requestedAngles: ["security", "tests", "security", "unknown"],
    maxParallel: 4,
  });
  assert.deepEqual(custom.angles, ["security", "tests"]);
});

test("mergeReviewerResults deduplicates findings and returns deterministic verdict", () => {
  const merged = mergeReviewerResults({
    headSha: "abc123",
    runResults: [
      {
        runId: "review-angle-01",
        angle: "correctness",
        findings: [
          { path: "src/app.ts", line: 10, message: "Handle null", severity: "high" },
          { message: "Consider edge case", severity: "low" },
        ],
      },
      {
        runId: "review-angle-02",
        angle: "security",
        verdictHint: "REQUEST_CHANGES",
        findings: [
          { path: "src/app.ts", line: 10, message: "Handle null", severity: "high" },
        ],
      },
    ],
  });

  assert.equal(merged.headSha, "abc123");
  assert.equal(merged.totalFindings, 2);
  assert.equal(merged.inlineComments.length, 1);
  assert.equal(merged.summaryFindings.length, 1);
  assert.equal(merged.verdict, "REQUEST_CHANGES");
  assert.equal(merged.runsMerged, 2);

  const approve = mergeReviewerResults({ headSha: "abc", runResults: [] });
  assert.equal(approve.verdict, "APPROVE");
});

 test("buildDraftReviewPayload converts merged review results into a deterministic pending-review payload", () => {
  const payload = buildDraftReviewPayload({
    headSha: "abc123",
    verdict: "REQUEST_CHANGES",
    totalFindings: 2,
    runsMerged: 2,
    inlineComments: [
      { path: "src/app.ts", line: 10, message: "Handle null", severity: "high" },
      { path: "", line: 10, message: "skip me" },
    ],
    summaryFindings: [
      { message: "Consider the stale draft-review cleanup path", severity: "low" },
    ],
  });

  assert.deepEqual(payload, {
    commit_id: "abc123",
    body: [
      "Reviewer-loop draft verdict: REQUEST_CHANGES",
      "Total findings: 2",
      "Review runs merged: 2",
      "",
      "Summary findings:",
      "- [low] Consider the stale draft-review cleanup path",
      "",
    ].join("\n"),
    comments: [
      {
        path: "src/app.ts",
        line: 10,
        body: "Handle null",
        side: "RIGHT",
      },
    ],
  });
});

 test("buildDraftReviewPayload renders a deterministic no-findings summary", () => {
  const payload = buildDraftReviewPayload({
    headSha: "abc123",
    verdict: "APPROVE",
    totalFindings: 0,
    runsMerged: 3,
    inlineComments: [],
    summaryFindings: [],
  });

  assert.deepEqual(payload, {
    commit_id: "abc123",
    body: [
      "Reviewer-loop draft verdict: APPROVE",
      "Total findings: 0",
      "Review runs merged: 3",
      "",
      "No summary-only findings were produced by the deterministic reviewer loop.",
      "",
    ].join("\n"),
    comments: [],
  });
});
