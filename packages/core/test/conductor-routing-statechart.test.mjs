// Structure and coverage tests for the conductor routing statechart
// (src/loop/conductor-routing-statechart.json), the routing policy source.
import assert from "node:assert/strict";
import { test } from "bun:test";

import chart from "../src/loop/conductor-routing-statechart.json" with { type: "json" };
import {
  evaluateConductorRouting,
  ROUTING_GUARDS,
  ROUTING_OUTCOME,
  selectRoutingArrow,
} from "../src/loop/conductor-routing.mjs";
import { buildInputs } from "./helpers/conductor-routing-inputs.mjs";

const inputs = buildInputs();

test("chart is plain JSON, uses only the XState v5 key allowlist, and every guard resolves", () => {
  const allowed = new Set(["id", "initial", "context", "states", "always", "target", "guard", "meta", "type"]);
  const checkKeys = (obj) => Object.keys(obj).forEach((k) => assert.ok(allowed.has(k), `key not allowed: ${k}`));
  checkKeys(chart);
  for (const [name, state] of Object.entries(chart.states)) {
    checkKeys(state);
    for (const arrow of state.always ?? []) {
      checkKeys(arrow);
      assert.ok(arrow.target in chart.states, `${name}: unknown target ${arrow.target}`);
      if (arrow.guard !== undefined) { assert.ok(Object.hasOwn(ROUTING_GUARDS, arrow.guard), arrow.guard); assert.equal(typeof ROUTING_GUARDS[arrow.guard], "function", arrow.guard); }
    }
  }
});

test("route arrows follow the rule order and end in the 7 routing outcomes", () => {
  const arrows = chart.states.route.always;
  const expectedRules = ["0a", "0b", "0c", ...Array.from({ length: 17 }, (_, i) => i + 1)];
  assert.deepEqual(arrows.map((a) => a.meta.rule), expectedRules);
  arrows.forEach((a, i) => assert.equal(a.guard === undefined, i === arrows.length - 1));
  const finals = Object.entries(chart.states).filter(([, s]) => s.type === "final").map(([n]) => n);
  assert.deepEqual([...finals].sort(), Object.values(ROUTING_OUTCOME).sort());
});

test("no dead arrow: every rule fires for some input in the full product", () => {
  const fired = new Set(inputs.map((input) => String(selectRoutingArrow(input).meta.rule)));
  const dead = chart.states.route.always.map((a) => String(a.meta.rule)).filter((rule) => !fired.has(rule));
  assert.deepEqual(dead, []);
});

test("requiresLocalIsolation passthrough: it never changes the outcome and the envelope echoes it", () => {
  const key = (input) => JSON.stringify({ ...input, requiresLocalIsolation: undefined });
  const byKey = new Map();
  for (const input of inputs) {
    const result = evaluateConductorRouting(input);
    const k = key(input);
    const prior = byKey.get(k);
    if (prior) assert.equal(prior, result.routingOutcome);
    byKey.set(k, result.routingOutcome);
    assert.equal(result.handoffEnvelope.requiresLocalIsolation, input.requiresLocalIsolation);
  }
});

test("fail-closed arrows fire for malformed target, blank states and duplicate owners", () => {
  const base = { target: { repo: "Acme/Widgets", pr: 7 }, copilotState: "pr_draft", reviewerState: "review_requested" };
  const cases = [
    ["0a", { ...base, target: { repo: "Acme/Widgets", pr: 0 } }, "unknown_state"],
    ["0a", { ...base, target: null }, "unknown_state"],
    ["0b", { ...base, copilotState: "  " }, "unknown_state"],
    ["0c", { ...base, reviewerState: "" }, "unknown_state"],
    ["1", { ...base, ownershipState: "duplicate_local_owners" }, "ownership_conflict"],
  ];
  for (const [rule, input, stopReason] of cases) {
    const result = evaluateConductorRouting(input);
    assert.equal(String(selectRoutingArrow(input).meta.rule), rule);
    assert.ok(Object.isFrozen(selectRoutingArrow(input)) && Object.isFrozen(selectRoutingArrow(input).meta));
    assert.equal(result.routingOutcome, ROUTING_OUTCOME.NEEDS_RECONCILE);
    assert.equal(result.stopReason, stopReason);
    assert.equal(result.handoffEnvelope.loopFamily, null);
    assert.equal(result.handoffEnvelope.entrypoint, null);
  }
});
