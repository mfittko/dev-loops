import path from "node:path";

import {
  runNode as runNodeHelper,
  withTempDir as withTempDirHelper,
  writeGhStub as writeGhStubHelper,
  writeJson as writeJsonHelper,
} from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/loop/inspect-run.mjs");

export const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);
export const writeJson = writeJsonHelper;

export async function writeGhStub(tempDir) {
  const prViewEntry = {
    assertArgs: ["pr", "view", "55", "--repo", "owner/repo", "--json"],
    stdout: JSON.stringify({
      headRefOid: "abc123",
      isDraft: false,
      state: "OPEN",
      number: 55,
      reviews: [],
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    }) + "\n",
  };
  const requestedReviewersEntry = {
    assertArgs: ["api", "repos/owner/repo/pulls/55/requested_reviewers"],
    stdout: JSON.stringify({ users: [{ login: "copilot-pull-request-reviewer[bot]" }, { login: "reviewer-user" }] }) + "\n",
  };
  const reviewsEntry = {
    assertArgs: ["api", "repos/owner/repo/pulls/55/reviews"],
    stdout: JSON.stringify([
      { id: 40, state: "COMMENTED", user: { login: "copilot-pull-request-reviewer[bot]" }, submitted_at: "2026-05-20T09:00:00Z", commit_id: "oldsha", html_url: "https://example.test/review/40" },
      { id: 41, state: "COMMENTED", user: { login: "reviewer-user" }, submitted_at: "2026-05-20T10:00:00Z", commit_id: "abc123", html_url: "https://example.test/review/41" },
    ]) + "\n",
  };
  const reviewsEntryWithPage = { ...reviewsEntry, assertArgs: ["api", "repos/owner/repo/pulls/55/reviews?per_page=100"] };
  const timelineEntry = {
    assertArgs: ["api", "repos/owner/repo/issues/55/timeline"],
    stdout: JSON.stringify([
      { event: "review_requested", created_at: "2026-05-20T08:55:00Z", requested_reviewer: { login: "copilot-pull-request-reviewer[bot]" } },
      { event: "review_requested", created_at: "2026-05-20T11:00:00Z", requested_reviewer: { login: "copilot-pull-request-reviewer[bot]" } },
    ]) + "\n",
  };
  const timelineEntryWithPage = { ...timelineEntry, assertArgs: ["api", "repos/owner/repo/issues/55/timeline?per_page=100"] };
  const commentsEntry = {
    assertArgs: ["api", "repos/owner/repo/pulls/55/comments"],
    stdout: JSON.stringify([
      { id: 101, created_at: "2026-05-20T09:01:00Z", user: { login: "copilot-pull-request-reviewer[bot]" } },
      { id: 102, created_at: "2026-05-20T09:02:00Z", user: { login: "copilot-pull-request-reviewer[bot]" } },
    ]) + "\n",
  };
  const commentsEntryWithPage = { ...commentsEntry, assertArgs: ["api", "repos/owner/repo/pulls/55/comments?per_page=100"] };
  const commitsEntry = {
    assertArgs: ["api", "repos/owner/repo/pulls/55/commits"],
    stdout: JSON.stringify([
      { sha: "oldsha", commit: { committer: { date: "2026-05-20T08:00:00Z" } }, author: { login: "copilot-swe-agent" } },
      { sha: "abc123", commit: { committer: { date: "2026-05-20T10:30:00Z" } }, author: { login: "author-user" } },
    ]) + "\n",
  };
  const commitsEntryWithPage = { ...commitsEntry, assertArgs: ["api", "repos/owner/repo/pulls/55/commits?per_page=100"] };
  const graphqlEntry = {
    assertArgs: ["api", "graphql"],
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }) + "\n",
  };

  return await writeGhStubHelper(
    tempDir,
    [
      ...Array.from({ length: 6 }, () => prViewEntry),
      ...Array.from({ length: 4 }, () => requestedReviewersEntry),
      ...Array.from({ length: 6 }, () => reviewsEntry),
      ...Array.from({ length: 6 }, () => reviewsEntryWithPage),
      ...Array.from({ length: 4 }, () => timelineEntry),
      ...Array.from({ length: 4 }, () => timelineEntryWithPage),
      ...Array.from({ length: 4 }, () => commentsEntry),
      ...Array.from({ length: 4 }, () => commentsEntryWithPage),
      ...Array.from({ length: 4 }, () => commitsEntry),
      ...Array.from({ length: 4 }, () => commitsEntryWithPage),
      ...Array.from({ length: 6 }, () => graphqlEntry),
    ],
    { matchMode: "claims" },
  );
}

export const withTempDir = (fn) => withTempDirHelper(fn, { prefix: "pi-inspect-run-test-" });

export function makeCopilotEvidence(state = "waiting_for_copilot_review", { sameHeadCleanConverged = false } = {}) {
  return {
    snapshot: {
      prExists: true,
      prNumber: 55,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      copilotReviewOnCurrentHead: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
      agentFixStatus: null,
    },
    interpretation: {
      state,
      allowedTransitions: ["unresolved_feedback_present", "ready_to_rerequest_review", "waiting_for_ci"],
      nextAction: "Wait for Copilot review",
      sameHeadCleanConverged,
    },
  };
}

export function makeReviewerEvidence(state = "waiting_for_author_followup", { submittedReviewState = "COMMENTED", submittedReviewPresent = true } = {}) {
  return {
    snapshot: {
      prExists: true,
      prNumber: 55,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      prHeadSha: "abc123",
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
      submittedReviewPresent,
      submittedReviewCommitSha: "abc123",
      submittedReviewState,
      reviewSubmissionStatus: "submitted",
    },
    interpretation: {
      state,
      allowedTransitions: ["waiting_for_re_request", "waiting_for_review_request"],
      nextAction: "Wait for author fixes or PR close/merge",
    },
  };
}
