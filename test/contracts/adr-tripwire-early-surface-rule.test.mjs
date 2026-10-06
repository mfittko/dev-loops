import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const doc = read("skills/docs/decision-record-contract.md");

test("ADR-TRIPWIRE-EARLY-SURFACE is registered once and owned by the decision record contract", () => {
  const rules = JSON.parse(read("skills/docs/required-rules.json")).requiredRules;
  assert.equal(rules.filter((r) => r.id === "ADR-TRIPWIRE-EARLY-SURFACE").length, 1);
  assert.equal(doc.split("<!-- rule: ADR-TRIPWIRE-EARLY-SURFACE -->").length, 2);
});

test("the rule pins the first draft hand-back, the stop and the no-resume obligations", () => {
  const row = doc.split("\n").find((line) => line.includes("<!-- rule: ADR-TRIPWIRE-EARLY-SURFACE -->"));
  assert.match(row, /coordinator MUST report an advisory hit to the operator in its first draft hand-back, before the first `draft_gate` round/u);
  assert.match(row, /coordinator MUST stop and hand back/u);
  assert.match(row, /orchestrator MUST NOT resume the coordinator while the coordination result still reports that action at the same head and PR body/u);
  assert.match(row, /resolve_adr_tripwire[\s\S]*resolve_size_budget[\s\S]*report_blocked/u);
});
