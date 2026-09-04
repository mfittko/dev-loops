import { SUBMITTED_REVIEW_STATES, isCopilotLogin, normalizeTimestamp } from "../github/copilot-helpers.mjs";
import { trimmedOrNull } from "./normalize.mjs";

const ACTIVE_COPILOT_REVIEW_REQUEST_STATUSES = new Set(["requested", "already-requested"]);

function normalizeReviewRequestEvents(events) {
  if (!Array.isArray(events)) {
    return [];
  }

  return events
    .map((event) => ({
      createdAtMs: normalizeTimestamp(event?.createdAt),
      requestedReviewerLogin: typeof event?.requestedReviewerLogin === "string"
        ? event.requestedReviewerLogin.trim()
        : "",
    }))
    .filter((event) => event.createdAtMs !== null && isCopilotLogin(event.requestedReviewerLogin))
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
}

function normalizeReviews(reviews) {
  if (!Array.isArray(reviews)) {
    return [];
  }

  return reviews
    .map((review, index) => {
      const state = typeof review?.state === "string" ? review.state.toUpperCase() : "";
      const submittedAtMs = normalizeTimestamp(review?.submittedAt ?? review?.createdAt);
      const authorLogin = typeof review?.authorLogin === "string"
        ? review.authorLogin.trim()
        : "";
      const commitSha = typeof review?.commitSha === "string" && review.commitSha.trim().length > 0
        ? review.commitSha.trim()
        : null;

      return {
        sortKey: index,
        state,
        submittedAtMs,
        authorLogin,
        commitSha,
      };
    })
    .filter((review) => review.submittedAtMs !== null && isCopilotLogin(review.authorLogin) && SUBMITTED_REVIEW_STATES.has(review.state))
    .sort((left, right) => left.submittedAtMs - right.submittedAtMs || left.sortKey - right.sortKey);
}

function normalizeReviewComments(comments) {
  if (!Array.isArray(comments)) {
    return [];
  }

  return comments
    .map((comment) => ({
      createdAtMs: normalizeTimestamp(comment?.createdAt),
      authorLogin: typeof comment?.authorLogin === "string" ? comment.authorLogin.trim() : "",
    }))
    .filter((comment) => comment.createdAtMs !== null && isCopilotLogin(comment.authorLogin))
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
}

function normalizeCommits(commits) {
  if (!Array.isArray(commits)) {
    return [];
  }

  return commits
    .map((commit, index) => ({
      sortKey: index,
      committedAtMs: normalizeTimestamp(commit?.committedAt),
      authorLogin: typeof commit?.authorLogin === "string" ? commit.authorLogin.trim() : "",
      sha: trimmedOrNull(commit?.sha),
    }))
    .filter((commit) => commit.committedAtMs !== null)
    .sort((left, right) => left.committedAtMs - right.committedAtMs || left.sortKey - right.sortKey);
}

function normalizeReviewThreadSummary(summary) {
  const totalThreads = typeof summary?.totalThreads === "number" && summary.totalThreads >= 0
    ? Math.floor(summary.totalThreads)
    : 0;
  const unresolvedThreads = typeof summary?.unresolvedThreads === "number" && summary.unresolvedThreads >= 0
    ? Math.floor(summary.unresolvedThreads)
    : 0;

  return {
    totalThreads,
    unresolvedThreads,
  };
}

export function summarizeCopilotLoopIterations({
  reviewRequestEvents,
  reviews,
  reviewComments,
  commits,
  reviewThreadSummary,
  currentHeadSha = null,
  currentReviewRequestStatus = "none",
  degraded = false,
  degradedReasons = [],
} = {}) {
  const normalizedReviewRequests = normalizeReviewRequestEvents(reviewRequestEvents);
  const normalizedReviews = normalizeReviews(reviews);
  const normalizedReviewComments = normalizeReviewComments(reviewComments);
  const normalizedCommits = normalizeCommits(commits);
  const normalizedThreadSummary = normalizeReviewThreadSummary(reviewThreadSummary);

  const hasActivePendingRequest = ACTIVE_COPILOT_REVIEW_REQUEST_STATUSES.has(currentReviewRequestStatus);
  const latestCompletedReview = normalizedReviews.at(-1) ?? null;
  const latestCompletedReviewAtMs = latestCompletedReview?.submittedAtMs ?? null;

  const pendingCopilotReviewRounds = hasActivePendingRequest
    && (
      latestCompletedReviewAtMs === null
      || normalizedReviewRequests.some((event) => event.createdAtMs > latestCompletedReviewAtMs)
      || (
        typeof currentHeadSha === "string"
        && currentHeadSha.length > 0
        && latestCompletedReview?.commitSha !== null
        && latestCompletedReview.commitSha !== currentHeadSha
      )
    )
    ? 1
    : 0;

  const completedCopilotReviewRounds = normalizedReviews.length;
  const hasCopilotLoopHistory =
    completedCopilotReviewRounds > 0
    || pendingCopilotReviewRounds > 0
    || normalizedReviewRequests.length > 0
    || normalizedReviewComments.length > 0;

  if (!hasCopilotLoopHistory) {
    return {
      available: false,
      source: "github_pr_timeline",
      reason: "no_copilot_review_history",
    };
  }

  const firstCopilotFeedbackAtMs = normalizedReviewComments[0]?.createdAtMs ?? null;
  const fixCommitsAfterFeedback = firstCopilotFeedbackAtMs === null
    ? 0
    : normalizedCommits.filter((commit) => commit.committedAtMs > firstCopilotFeedbackAtMs && commit.authorLogin.length > 0 && !isCopilotLogin(commit.authorLogin)).length;

  return {
    available: true,
    source: "github_pr_timeline",
    ...(degraded ? { degraded: true, degradedReasons: Array.isArray(degradedReasons) ? degradedReasons : [] } : {}),
    completedCopilotReviewRounds,
    pendingCopilotReviewRounds,
    copilotReviewRequests: normalizedReviewRequests.length,
    copilotReviewComments: normalizedReviewComments.length,
    resolvedReviewThreads: Math.max(0, normalizedThreadSummary.totalThreads - normalizedThreadSummary.unresolvedThreads),
    unresolvedReviewThreads: normalizedThreadSummary.unresolvedThreads,
    fixCommitsAfterFeedback,
  };
}
