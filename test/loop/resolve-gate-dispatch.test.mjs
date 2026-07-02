import assert from "node:assert/strict";
import test from "node:test";

import { parseSeverities } from "../../scripts/loop/resolve-gate-dispatch.mjs";

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
