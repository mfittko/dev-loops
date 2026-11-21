// PRE-PR-DEVELOPER-SELF-CHECK: the developer-checklist key on gates.draft.angles is the single source of the self-check items.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { FileConfigSchema, loadDevLoopConfig } from "@dev-loops/core/config";
import { FINAL_STEP_CHECKLIST_IDS, resolveChecklistItems } from "../../scripts/loop/_self-check-items.mjs";

const withChecklist = (lines) => ({ version: 1, gates: { draft: { angles: [{ name: "coverage", "developer-checklist": lines }] } } });

test("the config schema accepts a valid developer-checklist", () => {
  assert.equal(FileConfigSchema.safeParse(withChecklist(["C1: Add a test."])).success, true);
});

test("the config schema rejects a malformed, blank or empty developer-checklist", () => {
  for (const bad of [["no id here"], ["c1: lower case id"], ["C1:"], ["C1: "], []]) {
    assert.equal(FileConfigSchema.safeParse(withChecklist(bad)).success, false, JSON.stringify(bad));
  }
});

test("the shipped defaults carry the checklist ids under the mapped angles", async () => {
  const { config } = await loadDevLoopConfig({ repoRoot: process.cwd() });
  const byAngle = Object.fromEntries(config.gates.draft.angles.filter((a) => a["developer-checklist"]).map((a) => [a.name, a["developer-checklist"].map((l) => l.split(":")[0])]));
  assert.deepEqual(byAngle, {
    coverage: ["C1", "C2", "C3"],
    correctness: ["K1"],
    "contract-surface": ["CS1", "CS2"],
    "input-validation": ["I1", "I2"],
    "threat-model": ["T1"],
    "packaging-runtime": ["PK1"],
    "state-concurrency": ["S1"],
    "pr-description": ["P1", "P2"],
    holistic: ["K2"],
  });
});

test("resolveChecklistItems splits id and text and marks only the final-step ids", async () => {
  const items = await resolveChecklistItems(process.cwd(), ["src/b.mjs"]);
  assert.ok(items.length > 0 && items.length <= 14);
  assert.ok(!items.some((i) => i.id === "T1"), "T1 rides only a seam diff");
  assert.deepEqual(items.filter((i) => i.finalStep).map((i) => i.id).sort(), [...FINAL_STEP_CHECKLIST_IDS].sort());
  const c1 = items.find((i) => i.id === "C1");
  assert.equal(c1.angle, "coverage");
  assert.match(c1.check, /^For every new if, throw/);
});
