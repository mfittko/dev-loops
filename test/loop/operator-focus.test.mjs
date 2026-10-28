// Shared operator-focus carrier (GATE-EXEC-OPERATOR-FOCUS, ADR 0205, issue 2635).
import assert from "node:assert/strict";
import { test } from "bun:test";
import { OperatorFocusRefusal, bindOperatorFocusItems, normalizeOperatorFocus, renderOperatorFocusSection } from "../../scripts/loop/_operator-focus.mjs";

test("absent focus yields null and renders nothing", () => {
  assert.equal(normalizeOperatorFocus(undefined), null);
  assert.equal(renderOperatorFocusSection(null), "");
});

test("strings are sanitized: control characters become spaces, markup and backticks drop, spaces collapse", () => {
  const focus = normalizeOperatorFocus({ round: "a\u0007\nb  <script>`c`" });
  assert.equal(focus.round, "a b script c".replace("script c", "scriptc"));
});

test("refusals: over-length, empty, unknown field, duplicate fingerprint, items without allowItems, too many items", () => {
  const bad = (raw, opts) => assert.throws(() => normalizeOperatorFocus(raw, opts), OperatorFocusRefusal);
  bad({ round: "x".repeat(501) });
  bad({ round: "<>`" });
  bad({ other: "x" });
  bad({ items: [{ fingerprint: "f", decision: "d" }] });
  bad({ items: [{ fingerprint: "f", decision: "d" }, { fingerprint: "f", decision: "e" }] }, { allowItems: true });
  bad({ items: Array.from({ length: 21 }, (_, i) => ({ fingerprint: `f${i}`, decision: "d" })) }, { allowItems: true });
});

test("binding adds the act summary and an unknown fingerprint refuses", () => {
  const focus = normalizeOperatorFocus({ items: [{ fingerprint: "f1", decision: "pick B" }] }, { allowItems: true });
  const bound = bindOperatorFocusItems(focus, [{ fingerprint: "f1", summary: "two remedies A or B" }]);
  assert.match(renderOperatorFocusSection(bound), /Act item f1 \(two remedies A or B\): operator decision: pick B/);
  assert.throws(() => bindOperatorFocusItems(focus, [{ fingerprint: "f2", summary: "s" }]), OperatorFocusRefusal);
});
