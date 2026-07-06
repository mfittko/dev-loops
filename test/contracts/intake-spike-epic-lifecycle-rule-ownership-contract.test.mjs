import test from "node:test";

import { assertNotRestated, assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";

// #1158: single-owner rule IDs for the intake/spike/epic + lifecycle-policy
// cluster. Each doc below is the sole owner of its listed rule IDs; other
// docs reference these by ID instead of restating them.
const RULES_BY_OWNER = {
  "skills/docs/issue-intake-procedure.md": ["INTAKE-NEW-IDEA-SAFETY", "INTAKE-STOP-STATES"],
  "skills/docs/spike-mode-contract.md": [
    "SPIKE-STARTUP-SCAFFOLD-GATE",
    "SPIKE-EXIT-ELIGIBILITY",
    "SPIKE-DISCARD-ZERO-MUTATION",
    "SPIKE-GRADUATE-PLAN-FILE-REQUIRED",
    "SPIKE-RELAXED-GATE-PROFILE",
  ],
  "skills/docs/epic-tree-refinement-procedure.md": [
    "EPIC-REFINEMENT-SCOPE-BOUNDARY",
    "EPIC-REFINEMENT-REQUIRED-CONTRACTS",
    "EPIC-REFINEMENT-CONFIRM-BEFORE-MUTATE",
    "EPIC-REFINEMENT-SERIAL-PHASE-GATE",
  ],
  "skills/docs/tracker-first-loop-state.md": [
    "TRACKER-ONE-ACTIVE-PR",
    "TRACKER-PROJECTION-REQUIRED-METADATA",
    "TRACKER-PROJECTION-IDEMPOTENT",
    "TRACKER-BLOCKED-FAIL-CLOSED",
  ],
  "docs/steering-contract.md": [
    "STEERING-EXTERNAL-SCOPE-NARROW",
    "STEERING-LIVE-ADVERTISEMENT-FAIL-CLOSED",
    "STEERING-SEQ-MONOTONIC",
    "STEERING-HARD-CONSTRAINT-DEDUP",
  ],
  "skills/docs/retrospective-checkpoint-contract.md": [
    "RETRO-ENFORCEMENT-CONFIG-GATED",
    "RETRO-ADVISORY-NEVER-GATE",
    "RETRO-FINDINGS-ENVELOPE-CARRY",
    "RETRO-GATE-FAIL-CLOSED",
  ],
  "skills/docs/artifact-authority-contract.md": [
    "ARTIFACT-TWO-TIER-EXCLUSIVE",
    "ARTIFACT-TRACKER-FIRST-NO-DUP",
    "ARTIFACT-LIGHTWEIGHT-BODY-INVARIANTS",
    "ARTIFACT-LIGHTWEIGHT-PLAN-FILE-EXCLUSIVE",
    "ARTIFACT-STRATEGY-ENUM-FAIL-CLOSED",
  ],
};

test("intake/spike/epic/lifecycle cluster owns each rule ID exactly once (single owner)", () => {
  for (const [owner, ids] of Object.entries(RULES_BY_OWNER)) {
    for (const id of ids) {
      assertRulePresent(id);
      assertRuleOwned(id, owner);
    }
  }
});

test("issue-intake-procedure references facade/stop-condition rules by ID instead of restating them", () => {
  const referencedElsewhereOwnedRules = [
    "FACADE-LINKED-PR-SINGLE-ARTIFACT",
    "FACADE-BOOTSTRAP-WATCH-ROUTE",
    "FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION",
  ];
  for (const id of referencedElsewhereOwnedRules) {
    assertNotRestated(id, ["skills/docs/issue-intake-procedure.md"]);
  }
});

test("artifact-authority-contract's tracker-first no-duplicate rule is not restated in public-dev-loop-contract.md", () => {
  assertNotRestated("ARTIFACT-TRACKER-FIRST-NO-DUP", [
    "skills/docs/public-dev-loop-contract.md",
  ]);
});
