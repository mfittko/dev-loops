import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseSeverities } from "../../scripts/loop/resolve-gate-dispatch.mjs";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/loop/resolve-gate-dispatch.mjs", import.meta.url)
);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("parseSeverities trims and drops empty entries", () => {
  assert.deepEqual(parseSeverities("a, ,b"), ["a", "b"]);
});

test("parseSeverities returns [] for an empty string", () => {
  assert.deepEqual(parseSeverities(""), []);
});

test("parseSeverities returns undefined for null/undefined", () => {
  assert.equal(parseSeverities(undefined), undefined);
  assert.equal(parseSeverities(null), undefined);
});

// Regression: fail-CLOSED. When scope detection fails (scope.ok===false), the
// gate must route to full_fanout/scope_detection_failed, never collapse to
// inline. A bad --base ref makes the git diff inside detectScope fail offline.
test("scope.ok===false routes to full_fanout, never inline", () => {
  const out = execFileSync(
    process.execPath,
    [SCRIPT, "--gate", "draft", "--base", "nonexistent-ref-xyz-please"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const result = JSON.parse(out.trim());
  assert.equal(result.ok, true);
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "scope_detection_failed");
  assert.equal(result.threshold, null);
  assert.equal(result.scope.ok, false);
});
