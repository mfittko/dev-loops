import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The ONE node:-builtins-only copy of the canonical direct-run predicate
// (packages/core/src/cli/helpers.mjs `isDirectCliRun`) for scripts that CANNOT
// import @dev-loops/core: the release workflows (release.yml / npm-publish.yml)
// run that script family BEFORE `npm ci`, so a workspace import would
// ERR_MODULE_NOT_FOUND and silently skip `main()` — the #1886/#1901 incident
// class. Behavior is byte-identical to the canonical predicate and pinned by the
// release/entrypoint suites. realpath both sides so a relative
// `node scripts/release/foo.mjs` invocation still detects direct-run through a
// symlinked path (a brittle string compare could miss and skip main()).
export function isDirectCliRun(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
