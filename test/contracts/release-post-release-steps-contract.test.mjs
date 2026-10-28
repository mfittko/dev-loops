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
  const lastStep = body.indexOf("3. Prose cleanup.");
  const sentence = body.indexOf("Each of the three steps files its own issue in the next milestone.");
  assert.ok(lastStep > 0 && sentence > lastStep, "the issue-filing sentence follows all three steps and covers each");
  assert.ok(doc.indexOf("`RELEASE-COMBINED-RETRO`: A combined release retro runs once after a stable release, before the steps above.") > 0, "combined retro runs before the steps");
});

test("post-release rule is the standing explicit operator instruction", () => {
  assert.ok(doc.includes("This rule is the standing explicit operator instruction for these three issues"));
});

test("AGENTS.md cites the post-release rule as a standing instruction", () => {
  const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("`RELEASE-POST-RELEASE-RECURRING-STEPS`"));
});

test("combined release retro names inputs, required metrics and the skipped link-back", () => {
  const body = doc.slice(doc.indexOf("`RELEASE-COMBINED-RETRO`:"));
  for (const term of ["per-merge retros", "round data", "findings logs", "active minutes", "gate rounds", "parks by cause", "size-class approvals", "skipped"]) {
    assert.ok(body.includes(term), term);
  }
});
