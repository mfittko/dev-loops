// Pins the tiered gate vocabulary (issue #1913): `review` is a GATE_NAME but not
// a lifecycle gate. If `review` ever leaks into LIFECYCLE_GATES, or GATE_NAMES
// drifts from the [...LIFECYCLE_GATES, REVIEW_GATE] derivation, "run through the
// gates" disambiguation loses its code-level anchor and this test fails.
import assert from "node:assert/strict";
import test from "node:test";

import {
  GATE_NAMES,
  LIFECYCLE_GATES,
  REVIEW_GATE,
  normalizeGate,
} from "../../scripts/github/_gate-names.mjs";

test("LIFECYCLE_GATES are exactly the two transition-blocking gates", () => {
  assert.deepEqual(LIFECYCLE_GATES, ["draft_gate", "pre_approval_gate"]);
});

test("REVIEW_GATE is the informational review pass", () => {
  assert.equal(REVIEW_GATE, "review");
});

test("review is NOT a lifecycle gate", () => {
  assert.ok(!LIFECYCLE_GATES.includes("review"));
  assert.ok(!LIFECYCLE_GATES.includes(REVIEW_GATE));
});

test("GATE_NAMES is derived and byte-identical for existing consumers", () => {
  assert.deepEqual(GATE_NAMES, ["draft_gate", "pre_approval_gate", "review"]);
  assert.deepEqual(GATE_NAMES, [...LIFECYCLE_GATES, REVIEW_GATE]);
});

test("normalizeGate still accepts every tier member", () => {
  for (const gate of GATE_NAMES) {
    assert.equal(normalizeGate(gate), gate);
  }
});
