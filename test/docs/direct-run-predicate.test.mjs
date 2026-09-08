import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { isDirectCliRun } from "../../scripts/lib/direct-run.mjs";

// The release-workflow scripts (release.yml / npm-publish.yml, before `npm ci`)
// and the Claude asset generator all gate main() on this ONE node:-builtins-only
// predicate. A logic regression here would silently skip a release/publish
// main() (the #1886/#1901 incident class), and those callers import main()
// directly, so they never exercise the gate — hence this focused check.

test("isDirectCliRun is true when argv1 resolves to the module path (symlink-safe)", () => {
  assert.equal(isDirectCliRun(import.meta.url, fileURLToPath(import.meta.url)), true);
});

test("isDirectCliRun is false when argv1 is empty (imported, not run)", () => {
  assert.equal(isDirectCliRun(import.meta.url, ""), false);
});

test("isDirectCliRun fails safe (false) when a path cannot be realpath-resolved", () => {
  assert.equal(isDirectCliRun(import.meta.url, "/no/such/path/xyz.mjs"), false);
});
