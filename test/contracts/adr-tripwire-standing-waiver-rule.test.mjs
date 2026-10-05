import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

function ruleRow() {
  const row = read("skills/docs/decision-record-contract.md")
    .split("\n")
    .find((line) => line.includes("<!-- rule: ADR-TRIPWIRE-STANDING-WAIVER -->"));
  assert.ok(row, "ADR-TRIPWIRE-STANDING-WAIVER row is missing from the decision record contract");
  return row;
}

test("ADR-TRIPWIRE-STANDING-WAIVER is registered once and owned by the decision record contract", () => {
  const rules = JSON.parse(read("skills/docs/required-rules.json")).requiredRules;
  assert.equal(rules.filter((r) => r.id === "ADR-TRIPWIRE-STANDING-WAIVER").length, 1);
  assert.equal(read("skills/docs/decision-record-contract.md").split("<!-- rule: ADR-TRIPWIRE-STANDING-WAIVER -->").length, 2);
});

test("on resolve_adr_tripwire the orchestrator runs the writer before asking the operator and quotes the refusal reason", () => {
  const row = ruleRow();
  const order = /resolve_adr_tripwire[\s\S]*MUST run it before asking the operator[\s\S]*MUST quote the typed refusal reason/u;
  assert.match(row, order);
  assert.ok(row.includes("`dev-loops pr waive-adr-tripwire`"));
});

test("the dev-loop SKILL stop-condition names the orchestrator as the writer's actor", () => {
  assert.match(read("skills/dev-loop/SKILL.md"), /resolve_adr_tripwire` the coordinator stops and reports, and the orchestrator runs `dev-loops pr waive-adr-tripwire`/u);
  assert.match(read("scripts/loop/sanctioned-commands.mjs"), /orchestratorOwned[\s\S]*waive-adr-tripwire\.mjs/u);
});

test("the rule pins the refusal surfaces, the sole writer and the fixed exclusions", () => {
  const doc = read("skills/docs/decision-record-contract.md");
  const row = ruleRow();
  assert.match(row, /edit-pr\.mjs[\s\S]*refuse a body whose set of marker lines differs/u);
  assert.match(row, /create-pr\.mjs[\s\S]*refuse any marker line/u);
  for (const exclusion of ["extension-defaults.yaml", "rule-modality reversal", "unresolvable rule scan", "standingAuthorizations"]) {
    assert.ok(doc.includes(exclusion), `the standing waiver section must name ${exclusion}`);
  }
  assert.match(doc, /at most 90 days after `grantedAt`/u);
  assert.match(doc, /effective `\.devloops` config file on `origin\/<defaultBranch>`/u);
});

test("ADR 0119 amends ADR 0052 and leaves it unedited", () => {
  const adr = read("docs/decisions/0119-standing-authorization-for-adr-tripwire-waivers.md");
  assert.match(adr, /Amends \[0052\]\(\.\/0052-adr-tripwire-fail-closed\.md\)/u);
});
