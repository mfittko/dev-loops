// Re-export from shared library (Phase 2, issue #548)
export {
  parseCliTokens,
  requireOptionValue,
  requireTokenValue,
  parsePositiveInteger,
  parseNonNegativeInteger,
  parseAllowedRefsCsv,
  parsePrNumber,
  parseIssueNumber,
  resolveBodyOrFile,
  runChild,
  runCommand,
} from "@dev-loops/core/cli/primitives";

/** Value rule of `--standing-authorization` on the comment wrappers: bare, `true` or `1` is true. */
export function parseStandingAuthorizationValue(value) {
  return value === undefined || /^(?:true|1)$/iu.test(String(value).trim());
}
