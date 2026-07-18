import test from "node:test";

import { assertNotRestated, assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";

// #1151: skills/docs/worktree-guidance.md is the sole owner of all worktree rules;
// the anti-patterns, main-agent, merge-preconditions, and local-implementation
// docs reference these rules by ID instead of restating them.
const OWNER = "skills/docs/worktree-guidance.md";
const WORKTREE_RULE_IDS = [
  "WORKTREE-CANONICAL-PATH",
  "WORKTREE-CREATE-PROVISION",
  "WORKTREE-CLEANUP",
  "WORKTREE-DEFAULT-USE",
  "WORKTREE-DEPS-ISOLATED",
  "WORKTREE-DEDUPE",
  "WORKTREE-FALLBACK",
];

test("worktree-guidance owns every worktree rule by ID (single owner)", () => {
  for (const id of WORKTREE_RULE_IDS) {
    assertRulePresent(id);
    assertRuleOwned(id, OWNER);
  }
});

test("worktree rules are not restated in the referencing docs", () => {
  const referencingDocs = [
    "skills/docs/anti-patterns.md",
    "skills/docs/main-agent-contract.md",
    "skills/docs/merge-preconditions.md",
    "skills/local-implementation/SKILL.md",
  ];
  for (const id of WORKTREE_RULE_IDS) {
    assertNotRestated(id, referencingDocs);
  }
});
