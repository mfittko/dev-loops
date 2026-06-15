// Re-exports from shared library (Phase 2, issue #548)

export {
  formatCliError,
  parseJsonText,
  classifyReviewThreadsSignal,
  parseReviewThreads,
  readInput,
} from "@dev-loops/core/github/review-threads";

export {
  buildPhasePaths,
  readJsonIfExists,
} from "@dev-loops/core/loop/phase-files";

export {
  extractReviewCommitSha,
  isCopilotLogin,
  normalizeTimestamp,
  parseGateReviewCommentBody,
  parseGateReviewCommentMarkerBody,
  summarizeCopilotReviews,
  summarizeGateReviewCommentMarkers,
  summarizeGateReviewComments,
} from "@dev-loops/core/github/copilot-helpers";

export {
  buildParseError,
  isDirectCliRun,
} from "@dev-loops/core/cli/helpers";
