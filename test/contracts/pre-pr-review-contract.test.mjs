import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { assertRulePresent, assertRuleOwned } from "./_rule-helpers.mjs";

// Behavioral/contract pins for the pre-PR review phase (issue #2305): a
// developer-briefed, fresh-context, general-purpose review pass that runs
// before the first push, fixes findings in-tree, is ephemeral (no
// PR/thread/Copilot), bounded to one reviewer / two rounds, and leaves the
// fan-out gate as the authority. The model is config-resolved (never hardcoded).

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const CONTRACT = "skills/docs/pre-pr-review-contract.md";
const SKILL = "skills/local-implementation/SKILL.md";

test("pre-PR contract rules are present and owned by the contract doc", () => {
  for (const id of [
    "PRE-PR-BEFORE-FIRST-PUSH",
    "PRE-PR-ONE-FRESH-REVIEWER",
    "PRE-PR-BOUNDED-TWO-ROUNDS",
    "PRE-PR-EPHEMERAL-NO-ARTIFACTS",
    "PRE-PR-MODEL-CONFIG-RESOLVED",
    "PRE-PR-GATE-STILL-AUTHORITY",
    "PRE-PR-NOT-GATE-EVIDENCE",
  ]) {
    assertRulePresent(id);
    assertRuleOwned(id, CONTRACT);
  }
});

test("the local-implementation SKILL wires the phase before first push and references the contract", () => {
  assertRulePresent("LOCAL-PRE-PR-REVIEW-BEFORE-PUSH");
  assertRuleOwned("LOCAL-PRE-PR-REVIEW-BEFORE-PUSH", SKILL);
  const skill = readRepo(SKILL);
  assert.ok(skill.includes("pre-pr-review-contract.md"), "SKILL must link the pre-PR review contract");
  // The phase step sits before PR creation (step 12).
  const stepIdx = skill.indexOf("Pre-PR review pass");
  const prCreateIdx = skill.indexOf("create the PR from the working branch");
  assert.ok(stepIdx !== -1 && prCreateIdx !== -1 && stepIdx < prCreateIdx, "pre-PR review step must precede PR creation");
});

test("the contract encodes the bounded, ephemeral, config-resolved, pre-filter invariants", () => {
  const doc = readRepo(CONTRACT);
  // Before the first push.
  assert.match(doc, /before the first push/i);
  // One fresh-context general-purpose reviewer.
  assert.match(doc, /ONE\s+fresh-context, general-purpose reviewer/);
  // Bounded to at most two rounds.
  assert.match(doc, /AT MOST two internal rounds/);
  // Ephemeral: no PR/comment/thread/Copilot.
  assert.match(doc, /NO\s+pull request, NO comment, NO review thread, and NO Copilot/);
  // Config-resolved via resolveRoleModel with the pre-PR-reviewer role.
  assert.match(doc, /resolveRoleModel\(config, \{ role: "pre-PR-reviewer", harness \}\)/);
  // The fan-out gate stays the authority (pre-filter, not replacement).
  assert.match(doc, /pre-filter, not a\s+replacement/);
  assert.match(doc, /remains\s+the\s+authority/);
  // Adversarial-enumeration checklist floor.
  assert.match(doc, /adversarial-enumeration checklist/i);
  for (const item of ["errno", "symlink", "rename", "empty", "malformed", "path normalization"]) {
    assert.ok(doc.toLowerCase().includes(item), `checklist must name "${item}"`);
  }
});

test("no model literal is hardcoded in the phase prose or SKILL step (config-resolved only)", () => {
  // The concrete model (Fable) is a per-repo .devloops opt-in, never baked into
  // the harness-agnostic phase contract or its lifecycle wiring.
  for (const rel of [CONTRACT, SKILL]) {
    const text = readRepo(rel);
    assert.ok(!/claude-fable-5-1/.test(text), `${rel} must not hardcode a model literal (config-resolved)`);
    assert.ok(!/\bfable\b/i.test(text), `${rel} must not name a concrete model (config-resolved)`);
  }
  // The opt-in lives in .devloops.
  assert.ok(/claude-fable-5-1/.test(readRepo(".devloops")), ".devloops must carry the Fable opt-in");
});
