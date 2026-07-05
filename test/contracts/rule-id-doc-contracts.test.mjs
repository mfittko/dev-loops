import assert from "node:assert/strict";
import test from "node:test";

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
