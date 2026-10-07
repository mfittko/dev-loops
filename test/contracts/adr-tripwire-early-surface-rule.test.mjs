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
  assert.match(row, /a block is advisory and does not change `nextAction`/u);
  assert.match(row, /coordinator MUST stop and hand back/u);
  assert.match(row, /orchestrator MUST NOT resume the coordinator while the coordination result still reports that action at the same head and PR body/u);
  assert.match(row, /resolve_adr_tripwire[\s\S]*resolve_size_budget[\s\S]*report_blocked/u);
});

test("the rule pins the orchestrator-owned size waiver as the sole exit from resolve_size_budget", () => {
  const row = doc.split("\n").find((line) => line.includes("<!-- rule: ADR-TRIPWIRE-EARLY-SURFACE -->"));
  assert.match(row, /orchestrator \(not the coordinator\) flips ready at the same head with `pr ready-for-review --waive-size-budget --reason <r> \[--approved-by <h>\]`/u);
  assert.match(row, /only case where the no-resume rule yields/u);
});

test("the escalate wording aligns to the existing runner rule on the rule row, the ADR and the SKILL.md paragraph", () => {
  const row = doc.split("\n").find((line) => line.includes("<!-- rule: ADR-TRIPWIRE-EARLY-SURFACE -->"));
  const adr = read("docs/decisions/0123-adr-tripwire-early-surface.md");
  const paragraph = read("skills/dev-loop/SKILL.md").split("\n").find((line) => line.startsWith("The size-budget `block` and tripwire stops apply at the ready boundary"));
  assert.ok(paragraph);
  const wording = /During draft rounds a size-budget `escalate` is advisory \(reported in the hand-back\)\. After the ready flip the existing runner stop on `escalate` applies, and merge-pr's `size_budget_human_approval` enforces the approve-merge marker\./u;
  const contradiction = /escalate`? (is advisory (at every boundary|after the ready flip)|(stops|maps to `?resolve_size_budget|it is `resolve_size_budget)|[^.]*waiver)|advisory at every boundary|stops at the ready boundary|escalate`[^.]*(waive|waiver)/u;
  for (const surface of [row, adr, paragraph]) {
    assert.match(surface, wording);
    assert.doesNotMatch(surface, contradiction);
  }
});
