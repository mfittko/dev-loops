import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { assertRuleOwned } from "./_rule-helpers.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const GATE_CONTRACT = "skills/docs/gate-review-sub-loop-contract.md";
const PUSH_CONTRACT = "skills/docs/pre-pr-review-contract.md";

function ruleText(file, id) {
  const text = readRepo(file);
  const start = text.indexOf(`<!-- rule: ${id} -->`);
  assert.ok(start >= 0, `${id} missing from ${file}`);
  const end = text.indexOf("\n\n", start + 1);
  return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, " ");
}

test("the remediation site query rule lives in the gate contract and names its input-form and surface lists", () => {
  assertRuleOwned("GATE-EXEC-REMEDIATION-SITE-QUERY", GATE_CONTRACT);
  const rule = ruleText(GATE_CONTRACT, "GATE-EXEC-REMEDIATION-SITE-QUERY");
  for (const needle of ["defectClass", "siteQuery", "git grep", "acceptedForms", "rejectedForms", "one test per form", "PR body scope", "changes fragment", "JSDoc", "hook header", "doc comment", "skip reason", "ruleCitations", "registered rules"]) {
    assert.ok(rule.includes(needle), `rule text names ${needle}`);
  }
});

test("the judge and fixer agent definitions name the rule and their halves of it", () => {
  const judge = readRepo("agents/judge.agent.md");
  assert.ok(judge.includes("GATE-EXEC-REMEDIATION-SITE-QUERY"));
  for (const needle of ["siteQuery", "defectClass", "acceptedForms[]", "rejectedForms[]", "statedSurfaces[]", "required-rules.json"]) assert.ok(judge.includes(needle), `judge names ${needle}`);
  const fixer = readRepo("agents/fixer.agent.md");
  assert.ok(fixer.includes("GATE-EXEC-REMEDIATION-SITE-QUERY"));
  for (const needle of ["one test per form", "returnedSites[]", "skip reason", "ruleCitations[]", "residue"]) assert.ok(fixer.includes(needle), `fixer names ${needle}`);
});

test("the pre-push delta contract lists the remedy fields and states the residue rule", () => {
  assertRuleOwned("PRE-PUSH-DELTA-RESIDUE", PUSH_CONTRACT);
  const input = ruleText(PUSH_CONTRACT, "PRE-PUSH-DELTA-INPUT");
  assert.ok(input.includes("authorizedRemediation") && input.includes("siteQuery"));
  const residue = ruleText(PUSH_CONTRACT, "PRE-PUSH-DELTA-RESIDUE");
  for (const needle of ["residueOf", "never defers", "rationale", "same fix commit", "skipReason", "blocks", "siteCoverage", "commit_only", "MUST equal the reason"]) assert.ok(residue.includes(needle), `residue rule names ${needle}`);
  assert.ok(ruleText(PUSH_CONTRACT, "PRE-PUSH-DELTA-EXIT-BOUND").includes("PRE-PUSH-DELTA-RESIDUE"));
  const conflictEvidence = ruleText("skills/docs/spec-authority-contract.md", "SPEC-AUTHORITY-CONFLICT-EVIDENCE");
  assert.ok(conflictEvidence.includes("defectClass") && conflictEvidence.includes("siteQuery"));
});

test("the recurrence escalation rule names the key, the threshold, the stop and both outcomes", () => {
  assertRuleOwned("GATE-EXEC-RECURRENCE-ESCALATION", GATE_CONTRACT);
  const rule = ruleText(GATE_CONTRACT, "GATE-EXEC-RECURRENCE-ESCALATION");
  for (const needle of ["(file, symbol)", "specDigest", "escalations[]", "3 or more", "human checkpoint", "design decision", "split into its own issue", "persists no counter"]) {
    assert.ok(rule.includes(needle), `rule text names ${needle}`);
  }
  assert.ok(readRepo("agents/gate-coordinator.agent.md").includes("GATE-EXEC-RECURRENCE-ESCALATION"));
  const devLoop = readRepo("agents/dev-loop.agent.md");
  assert.ok(devLoop.includes("GATE-EXEC-RECURRENCE-ESCALATION") && devLoop.includes("human checkpoint"));
});
