// Re-export from shared library (Phase 2, issue #548)
export {
  requireOptionValue,
  parsePositiveInteger,
  parseNonNegativeInteger,
  parsePrNumber,
  parseIssueNumber,
  runChild,
  runCommand,
} from "../packages/core/src/cli/primitives.mjs";
