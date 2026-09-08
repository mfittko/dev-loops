// The ONE node:-builtins-only copy of the canonical CLI-error formatter
// (packages/core/src/github/review-threads.mjs `formatCliError`) for scripts
// whose import closure MUST stay @dev-loops/core-free: the release workflows
// (release.yml / npm-publish.yml) run the release-script family with bare
// `node` BEFORE any install, so any transitive `@dev-loops/core` import would
// ERR_MODULE_NOT_FOUND at module load and crash the release. jq-output.mjs is
// on that closure (verify-release-approval imports it), so it imports this pure
// copy instead of ../_core-helpers.mjs (which re-exports from @dev-loops/core).
//
// Behavior is byte-identical to the canonical formatter and pinned by
// test/docs/format-cli-error.test.mjs (parity against the core export), the
// same drift-guard pattern direct-run.mjs uses.
//
// Renders the one shared { ok: false, error, hint? } envelope every
// JSON-emitting gate CLI's main() catch block prints to stderr. `usage` is a
// PRESENCE check only: when the error carries a usage string (or a caller
// passes one), a one-line `hint` points at --help rather than inlining the
// multi-KB usage text into the JSON payload.
export function formatCliError(error, { usage } = {}) {
  const payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
  const hasUsage = (error instanceof Error && typeof error.usage === "string") || typeof usage === "string";
  if (hasUsage) {
    payload.hint = "run with --help for usage";
  }
  return JSON.stringify(payload);
}
