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
  const dataLines = table[0].split("\n").filter((line) => /^\| (0[abc]|\d+) \|/.test(line));
  const parsed = dataLines
    .map((line) => line.match(/^\| (0[abc]|\d+) \| .*? \| `([a-z_]+)`(?: \(`([a-z_]+)`\))?/))
    .filter(Boolean)
    .map(([, rule, outcome, stopReason]) => ({ rule, outcome, stopReason: stopReason ?? null }));
  assert.equal(parsed.length, dataLines.length, "table has a row the parser cannot read");
  return parsed;
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

test("freshness check fails for a swapped, deleted or malformed table row in the contract text", () => {
  const markdown = readFileSync(contractPath, "utf8");
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith("| 0a |"));
  assert.ok(start >= 0, "first table row not found");

  const swapped = [...lines];
  [swapped[start], swapped[start + 1]] = [swapped[start + 1], swapped[start]];
  const deleted = lines.filter((_, index) => index !== start);
  const malformed = [...lines];
  malformed[start] = malformed[start].replace("`needs_reconcile`", "needs_reconcile");
  assert.notEqual(malformed[start], lines[start], "malformed mutation must change the row");

  assert.notDeepEqual(parseTable(swapped.join("\n")), chartRows);
  assert.notDeepEqual(parseTable(deleted.join("\n")), chartRows);
  assert.throws(() => parseTable(malformed.join("\n")), /cannot read/);

  const appended = [...lines];
  const last = lines.findIndex((line) => line.startsWith("| 17 |"));
  appended.splice(last + 1, 0, "| 18 | x | needs_reconcile |");
  assert.throws(() => parseTable(appended.join("\n")), /cannot read/);
});
