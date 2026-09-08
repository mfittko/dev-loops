// Re-exports from shared library (Phase 2, issue #548)

// formatCliError is re-exported from the node:-pure copy (single source of
// truth), so its importers here are unaffected while the release-script closure
// (jq-output.mjs) can import it without pulling in @dev-loops/core.
export { formatCliError } from "./lib/format-cli-error.mjs";

export {
  parseJsonText,
  classifyReviewThreadsSignal,
  parseReviewThreads,
  parseUnresolvedThreadBodies,
  readInput,
} from "@dev-loops/core/github/review-threads";

export {
  buildPhasePaths,
  readJsonIfExists,
} from "@dev-loops/core/loop/phase-files";

export {
  containsBareCopilotSummon,
  extractReviewCommitSha,
  isCopilotLogin,
  isGateMachineArtifactBody,
  normalizeTimestamp,
  normalizeVerdictSurface,
  parseGateReviewCommentBody,
  parseGateReviewCommentMarkerBody,
  resolveDraftGateRoundResetMs,
  resolveCopilotReviewPresence,
  sanitizeCopilotSummonTokens,
  summarizeCopilotReviews,
  summarizeGateReviewCommentMarkers,
  summarizeGateReviewComments,
} from "@dev-loops/core/github/copilot-helpers";

export {
  buildParseError,
  isDirectCliRun,
} from "@dev-loops/core/cli/helpers";
