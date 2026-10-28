import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";

const OWNER = "skills/docs/release-runbook.md";
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const doc = fs.readFileSync(path.join(repoRoot, OWNER), "utf8");

test("release runbook owns the recurring post-release rules by ID", () => {
  for (const id of [
    "RELEASE-POST-RELEASE-RECURRING-STEPS",
    "RELEASE-COMBINED-RETRO",
    "RELEASE-COMMIT-EXPLICIT-STAGING",
    "RELEASE-CANCEL-PUBLISH-FIRST",
  ]) {
    assertRulePresent(id);
    assertRuleOwned(id, OWNER);
  }
});

test("post-release steps run audit, then memory cleanup, then prose cleanup", () => {
  const body = doc.slice(doc.indexOf("`RELEASE-POST-RELEASE-RECURRING-STEPS`:"));
  const order = ["Contract and codebase audit", "Memory cleanup", "Prose cleanup"].map((s) => body.indexOf(s));
  assert.ok(order.every((i) => i > 0), "all three steps present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "steps in order");
  assert.match(body, /files its own issue in the next milestone/);
});

test("combined release retro names inputs, required metrics and the skipped link-back", () => {
  const body = doc.slice(doc.indexOf("`RELEASE-COMBINED-RETRO`:"));
  for (const term of ["per-merge retros", "round data", "findings logs", "active minutes", "gate rounds", "parks by cause", "size-class approvals", "skipped"]) {
    assert.ok(body.includes(term), term);
  }
});
