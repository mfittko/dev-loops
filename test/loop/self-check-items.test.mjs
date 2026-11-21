import assert from "node:assert/strict";
import { test } from "bun:test";

import { ANGLE_LINE_MAX, condenseAnglePrompt, resolveSelfCheckAngles } from "../../scripts/loop/_self-check-items.mjs";

test("condenseAnglePrompt keeps the first sentence, caps it, and falls back for an empty prompt", () => {
  assert.equal(condenseAnglePrompt("Check tests.  Then more\ntext.", "a"), "Check tests.");
  assert.equal(condenseAnglePrompt("x".repeat(500), "a").length, ANGLE_LINE_MAX);
  assert.equal(condenseAnglePrompt("", "coverage"), "Apply the coverage review angle while writing.");
  assert.equal(condenseAnglePrompt(undefined, "coverage"), "Apply the coverage review angle while writing.");
});

test("resolveSelfCheckAngles falls back to the shipped defaults, capped at 8 lines, for a root without config", async () => {
  const angles = await resolveSelfCheckAngles("/nonexistent-issue-3395-root", ["a.mjs"]);
  assert.ok(angles.length > 0 && angles.length <= 8);
  assert.ok(angles.every((a) => a.id === `angle:${a.angle}` && a.constraint.length <= ANGLE_LINE_MAX));
});
