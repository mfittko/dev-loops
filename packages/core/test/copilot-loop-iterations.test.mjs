import assert from "node:assert/strict";
import { test } from "bun:test";

import { summarizeCopilotLoopIterations } from "../src/loop/copilot-loop-iterations.mjs";

test("summarizeCopilotLoopIterations returns deterministic completed/pending/comment/thread/fix counts", () => {
  const summary = summarizeCopilotLoopIterations({
    reviewRequestEvents: [
      { createdAt: "2026-05-01T10:00:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-02T10:00:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-03T10:00:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-04T10:00:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-05T10:00:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
    ],
    reviews: [
      { state: "COMMENTED", submittedAt: "2026-05-01T10:05:00Z", authorLogin: "copilot-pull-request-reviewer[bot]", commitSha: "sha-1" },
      { state: "COMMENTED", submittedAt: "2026-05-02T10:05:00Z", authorLogin: "copilot-pull-request-reviewer[bot]", commitSha: "sha-2" },
      { state: "COMMENTED", submittedAt: "2026-05-03T10:05:00Z", authorLogin: "copilot-pull-request-reviewer[bot]", commitSha: "sha-3" },
      { state: "APPROVED", submittedAt: "2026-05-04T10:05:00Z", authorLogin: "copilot-pull-request-reviewer[bot]", commitSha: "sha-4" },
      { state: "COMMENTED", submittedAt: "2026-05-04T11:00:00Z", authorLogin: "reviewer-user", commitSha: "sha-4" },
    ],
    reviewComments: [
      { createdAt: "2026-05-01T10:06:00Z", authorLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-01T10:07:00Z", authorLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-02T10:06:00Z", authorLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-02T10:07:00Z", authorLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-03T10:06:00Z", authorLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-03T10:07:00Z", authorLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-04T10:06:00Z", authorLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-04T10:07:00Z", authorLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-04T11:07:00Z", authorLogin: "reviewer-user" },
    ],
    commits: [
      { sha: "boot", committedAt: "2026-05-01T09:00:00Z", authorLogin: "copilot-swe-agent" },
      { sha: "fix-1", committedAt: "2026-05-01T11:00:00Z", authorLogin: "alice" },
      { sha: "fix-2", committedAt: "2026-05-02T11:00:00Z", authorLogin: "alice" },
      { sha: "assistant", committedAt: "2026-05-03T11:00:00Z", authorLogin: "copilot-swe-agent" },
      { sha: "fix-3", committedAt: "2026-05-04T11:00:00Z", authorLogin: "bob" },
    ],
    reviewThreadSummary: {
      totalThreads: 8,
      unresolvedThreads: 0,
    },
    currentHeadSha: "sha-5",
    currentReviewRequestStatus: "requested",
  });

  assert.deepEqual(summary, {
    available: true,
    source: "github_pr_timeline",
    completedCopilotReviewRounds: 4,
    pendingCopilotReviewRounds: 1,
    copilotReviewRequests: 5,
    copilotReviewComments: 8,
    resolvedReviewThreads: 8,
    unresolvedReviewThreads: 0,
    fixCommitsAfterFeedback: 3,
  });
});

test("summarizeCopilotLoopIterations keeps duplicate post-review request events to one pending round", () => {
  const summary = summarizeCopilotLoopIterations({
    reviewRequestEvents: [
      { createdAt: "2026-05-01T10:00:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-02T10:00:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-02T10:01:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
      { createdAt: "2026-05-02T10:02:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
    ],
    reviews: [
      { state: "COMMENTED", submittedAt: "2026-05-01T10:05:00Z", authorLogin: "copilot-pull-request-reviewer[bot]", commitSha: "sha-1" },
    ],
    reviewComments: [],
    commits: [],
    reviewThreadSummary: {
      totalThreads: 1,
      unresolvedThreads: 1,
    },
    currentHeadSha: "sha-2",
    currentReviewRequestStatus: "requested",
  });

  assert.equal(summary.available, true);
  assert.equal(summary.completedCopilotReviewRounds, 1);
  assert.equal(summary.pendingCopilotReviewRounds, 1);
  assert.equal(summary.copilotReviewRequests, 4);
});

test("summarizeCopilotLoopIterations marks pending round when current head differs from latest review sha without a later request event", () => {
  const summary = summarizeCopilotLoopIterations({
    reviewRequestEvents: [
      { createdAt: "2026-05-01T10:00:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
    ],
    reviews: [
      { state: "COMMENTED", submittedAt: "2026-05-01T10:05:00Z", authorLogin: "copilot-pull-request-reviewer[bot]", commitSha: "sha-1" },
    ],
    reviewComments: [],
    commits: [],
    reviewThreadSummary: {
      totalThreads: 0,
      unresolvedThreads: 0,
    },
    currentHeadSha: "sha-2",
    currentReviewRequestStatus: "requested",
  });

  assert.equal(summary.available, true);
  assert.equal(summary.completedCopilotReviewRounds, 1);
  assert.equal(summary.pendingCopilotReviewRounds, 1);
});

test("summarizeCopilotLoopIterations surfaces degraded flags for truncated sources", () => {
  const summary = summarizeCopilotLoopIterations({
    reviewRequestEvents: [
      { createdAt: "2026-05-01T10:00:00Z", requestedReviewerLogin: "copilot-pull-request-reviewer[bot]" },
    ],
    reviews: [
      { state: "COMMENTED", submittedAt: "2026-05-01T10:05:00Z", authorLogin: "copilot-pull-request-reviewer[bot]", commitSha: "sha-1" },
    ],
    reviewComments: [],
    commits: [],
    reviewThreadSummary: {
      totalThreads: 1,
      unresolvedThreads: 0,
    },
    currentHeadSha: "sha-1",
    currentReviewRequestStatus: "none",
    degraded: true,
    degradedReasons: ["reviews_page_cap"],
  });

  assert.equal(summary.available, true);
  assert.equal(summary.degraded, true);
  assert.deepEqual(summary.degradedReasons, ["reviews_page_cap"]);
});

test("summarizeCopilotLoopIterations marks no-review/no-request PRs unavailable", () => {
  const summary = summarizeCopilotLoopIterations({
    reviewRequestEvents: [],
    reviews: [],
    reviewComments: [],
    commits: [],
    reviewThreadSummary: {
      totalThreads: 0,
      unresolvedThreads: 0,
    },
    currentHeadSha: "sha-1",
    currentReviewRequestStatus: "none",
  });

  assert.deepEqual(summary, {
    available: false,
    source: "github_pr_timeline",
    reason: "no_copilot_review_history",
  });
});
