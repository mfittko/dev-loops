import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

import { assertNotRestated, assertRuleOwned, assertRulePresent, extractOwnedText } from "./_rule-helpers.mjs";

test("stop-conditions rules are owned by rule ID, not phrase pins", () => {
  for (const id of [
    "STOP-BLOCKED-001",
    "STOP-DONE-001",
    "STOP-APPROVAL-001",
    "STOP-MERGE-AUTH-001",
    "STOP-HUMAN-MERGE-001",
    "STOP-RECONCILE-001",
    "STOP-STARTUP-INPUTS-001",
    "STOP-WAIT-001",
    "STOP-INITIAL-COPILOT-001",
    "STOP-COPILOT-REVIEW-001",
    "STOP-QUIET-WATCHER-001",
  ]) {
    assertRulePresent(id);
    assertRuleOwned(id, "skills/docs/stop-conditions.md");
  }
  assertNotRestated("STOP-COPILOT-REVIEW-001", [
    "skills/docs/public-dev-loop-contract.md",
    "skills/copilot-pr-followup/SKILL.md",
  ]);
});

test("extractOwnedText falls back to the next line when the marker sits alone", () => {
  const content = "<!-- rule: TEST-RULE-001 -->\nThe agent MUST stop before merge and report the reconcile gate.";
  assert.equal(
    extractOwnedText(content, "TEST-RULE-001"),
    "The agent MUST stop before merge and report the reconcile gate.",
  );
});

test("GATE-EXEC-FINDINGS-LOG-QUARANTINE is owned by the gate review sub-loop contract and registered (#2969)", () => {
  assertRuleOwned("GATE-EXEC-FINDINGS-LOG-QUARANTINE", "skills/docs/gate-review-sub-loop-contract.md");
  assert.match(readFileSync(new URL("../../skills/docs/required-rules.json", import.meta.url), "utf8"), /"id": "GATE-EXEC-FINDINGS-LOG-QUARANTINE"/);
});

test("GATE-EXEC-ROUTED-RESIDUE-INPUT is owned by the gate review sub-loop contract and registered (#2971)", () => {
  assertRuleOwned("GATE-EXEC-ROUTED-RESIDUE-INPUT", "skills/docs/gate-review-sub-loop-contract.md");
  assert.match(readFileSync(new URL("../../skills/docs/required-rules.json", import.meta.url), "utf8"), /"id": "GATE-EXEC-ROUTED-RESIDUE-INPUT"/);
});

test("GATE-EXEC-OPERATOR-FOCUS is owned by the gate review sub-loop contract and registered (#2635)", () => {
  assertRuleOwned("GATE-EXEC-OPERATOR-FOCUS", "skills/docs/gate-review-sub-loop-contract.md");
  assert.match(readFileSync(new URL("../../skills/docs/required-rules.json", import.meta.url), "utf8"), /"id": "GATE-EXEC-OPERATOR-FOCUS"/);
});

test("GATE-EXEC-BODY-ONLY-RERUN is owned by the gate review sub-loop contract, registered and names its clauses", () => {
  assertRuleOwned("GATE-EXEC-BODY-ONLY-RERUN", "skills/docs/gate-review-sub-loop-contract.md");
  assert.match(readFileSync(new URL("../../skills/docs/required-rules.json", import.meta.url), "utf8"), /"id": "GATE-EXEC-BODY-ONLY-RERUN"/);
  const rule = extractOwnedText(readFileSync(new URL("../../skills/docs/gate-review-sub-loop-contract.md", import.meta.url), "utf8"), "GATE-EXEC-BODY-ONLY-RERUN");
  for (const needle of ["pr-body", "pr_body_stale", "ADR 0256", "always"]) assert.ok(rule.includes(needle), needle);
});

test("the gate contract states the retained-round rule on the round cap and the disposition memory", () => {
  const contract = readFileSync(new URL("../../skills/docs/gate-review-sub-loop-contract.md", import.meta.url), "utf8");
  const cap = extractOwnedText(contract, "GATE-EXEC-ROUND-CAP");
  for (const needle of [".round-<n>.json", "isInRoundRewrite", "resolveGateRound"]) assert.ok(cap.includes(needle), needle);
  const memory = contract.split("\n").find((line) => line.startsWith("**Disposition memory into a re-running reviewer's briefing"));
  assert.ok(memory.includes(".round-<n>.json"));
});
