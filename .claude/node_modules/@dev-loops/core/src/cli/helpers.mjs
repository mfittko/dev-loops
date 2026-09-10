import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Shared CLI helpers for script boilerplate reduction.
 * Extracted from scripts/_core-helpers.mjs per issue #548 Phase 2.
 */

export function buildParseError(usage) {
  return function parseError(message) {
    return Object.assign(new Error(message), { usage });
  };
}

export function isDirectCliRun(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1.length === 0) { return false; }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
