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
  canonicalizeScope,
  gateScopePrefix,
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

// Issue #1957: canonicalizeScope maps a gate-id-derived scope's underscores to
// the hyphen-only convention every --scope validator (VALID_SCOPE_RE) enforces,
// so a gate-group scope validates without a self-correction retry.
test("canonicalizeScope maps underscore gate ids to the hyphen scope convention", () => {
  assert.equal(canonicalizeScope("draft_gate-group-docs-surface"), "draft-gate-group-docs-surface");
  assert.equal(canonicalizeScope("pre_approval_gate-group-a"), "pre-approval-gate-group-a");
  // Idempotent on already-canonical (hyphen-only) scopes.
  assert.equal(canonicalizeScope("draft-gate-coverage"), "draft-gate-coverage");
});

test("gateScopePrefix reuses canonicalizeScope so the two normalizations never drift", () => {
  assert.equal(gateScopePrefix("draft_gate"), "draft-gate-");
  assert.equal(gateScopePrefix("pre_approval_gate"), "pre-approval-gate-");
  assert.equal(gateScopePrefix("draft_gate"), `${canonicalizeScope("draft_gate")}-`);
});
