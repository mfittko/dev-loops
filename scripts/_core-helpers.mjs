// Re-exports from shared library (Phase 2, issue #548)

export {
  formatCliError,
  parseJsonText,
  classifyReviewThreadsSignal,
  parseReviewThreads,
  readInput,
} from "../packages/core/src/github/review-threads.mjs";

export {
  buildPhasePaths,
  readJsonIfExists,
} from "../packages/core/src/loop/phase-files.mjs";

export {
  extractReviewCommitSha,
  isCopilotLogin,
  normalizeTimestamp,
  parseGateReviewCommentBody,
  parseGateReviewCommentMarkerBody,
  summarizeCopilotReviews,
  summarizeGateReviewCommentMarkers,
  summarizeGateReviewComments,
} from "../packages/core/src/github/copilot-helpers.mjs";

export {
  buildParseError,
  isDirectCliRun,
} from "../packages/core/src/cli/helpers.mjs";
