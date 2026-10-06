// Freshness: the hand-written ROUTING-PRIORITY-ORDER table must match the chart arrows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

import chart from "../src/loop/conductor-routing-statechart.json" with { type: "json" };

const contractPath = new URL("../../../skills/docs/conductor-routing-contract.md", import.meta.url);

function parseTable(markdown) {
  const section = markdown.split("<!-- rule: ROUTING-PRIORITY-ORDER -->")[1];
  assert.ok(section, "ROUTING-PRIORITY-ORDER marker not found");
  const table = section.match(/^\| Priority \|[^\n]*\n(?:\|[^\n]*\n?)+/m);
  assert.ok(table, "priority table not found");
  return table[0]
    .split("\n")
    .map((line) => line.match(/^\| (0[abc]|\d+) \| .*? \| `([a-z_]+)`(?: \(`([a-z_]+)`\))?/))
    .filter(Boolean)
    .map(([, rule, outcome, stopReason]) => ({ rule, outcome, stopReason: stopReason ?? null }));
}

const chartRows = chart.states.route.always.map((arrow) => ({
  rule: String(arrow.meta.rule),
  outcome: arrow.target,
  stopReason: arrow.meta.stopReason ?? null,
}));

test("contract priority table matches the chart arrows in order, outcomes and stop reasons", () => {
  const rows = parseTable(readFileSync(contractPath, "utf8"));
  assert.equal(rows.length, 20);
  assert.deepEqual(rows, chartRows);
});

test("freshness check fails for a reordered or missing table row", () => {
  const rows = parseTable(readFileSync(contractPath, "utf8"));
  const reordered = [rows[1], rows[0], ...rows.slice(2)];
  assert.notDeepEqual(reordered, chartRows);
  assert.notDeepEqual(rows.slice(1), chartRows);
});
