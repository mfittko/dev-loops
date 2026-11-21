import assert from "node:assert/strict";
import { test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ANGLE_LINE_MAX, condenseAnglePrompt, requiredSelfCheckIds, resolveChecklistItems, resolveSelfCheckAngles } from "../../scripts/loop/_self-check-items.mjs";

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

test("strict resolvers throw pre_pr_self_check_missing on a config load error", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "issue-3395-strict-"));
  try {
    writeFileSync(path.join(dir, ".devloops"), "{not json");
    await assert.rejects(resolveChecklistItems(dir, ["a.mjs"], { strict: true }), { code: "pre_pr_self_check_missing" });
    await assert.rejects(resolveSelfCheckAngles(dir, ["a.mjs"], { strict: true }), { code: "pre_pr_self_check_missing" });
    await assert.rejects(requiredSelfCheckIds(dir, "main"), { code: "pre_pr_self_check_missing" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a duplicate developer-checklist id across angles is refused in strict mode and empty in best-effort mode", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "issue-3395-dup-"));
  try {
    writeFileSync(path.join(dir, ".devloops"), JSON.stringify({ version: 1, gates: { draft: { angles: [{ name: "coverage", "developer-checklist": ["C1: reuse"] }, { name: "correctness", "developer-checklist": ["C1: clash"] }] } } }));
    await assert.rejects(resolveChecklistItems(dir, ["a.mjs"], { strict: true }), { code: "pre_pr_self_check_missing", message: /duplicate developer-checklist id C1/u });
    assert.deepEqual(await resolveChecklistItems(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolveChecklistItems skips the checklist of an angle a consumer layer disables with enabled: false", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "issue-3395-disabled-"));
  try {
    writeFileSync(path.join(dir, ".devloops"), JSON.stringify({ version: 1, gates: { draft: { angles: [{ name: "threat-model", enabled: false }] } } }));
    assert.ok(!(await resolveChecklistItems(dir, ["a.mjs"], { strict: true })).some((i) => i.id === "T1"));
    assert.ok((await resolveChecklistItems(dir, ["a.mjs"], { strict: true })).some((i) => i.id === "C1"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("requiredSelfCheckIds refuses with pre_pr_self_check_missing when git diff fails for an unresolvable base", async () => {
  await assert.rejects(requiredSelfCheckIds(process.cwd(), "no-such-ref-issue-3395"), { code: "pre_pr_self_check_missing", message: /git diff/u });
});
