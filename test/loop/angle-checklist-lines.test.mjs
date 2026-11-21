// Issue 3396 ac:3/ac:4: the A1-A8 angle lines, the pr-description headings and the single per-angle source.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDevLoopConfig, resolveReviewerRole } from "@dev-loops/core/config";
import { ANGLE_LINE_MAX, resolveChecklistItems } from "../../scripts/loop/_self-check-items.mjs";

// A1, A2, A5 and A7 merged into K2, I2, CS1 and PK1 (same-angle duplicates).
const A_LINES = {
  K2: ["holistic", "confirm it accepts exactly what the producer now emits"],
  I2: ["input-validation", "(quoting, continuations, substitutions, abbreviations, nesting, case)"],
  A3: ["state-concurrency", "retained versus live copies, interrupted writes, symlinks and stale remote refs"],
  A4: ["contract-surface", "Trace each refusal remedy and documented command through the target CLI parser"],
  CS1: ["contract-surface", "skills/docs, docs/decisions, exit-code tables and JSDoc"],
  A6: ["determinism", "caller cwd, a checkout subdirectory, relative path arguments, inherited GIT_* env vars"],
  A8: ["contradiction-lens", "Check each new instruction against agents/*.agent.md"],
};
const MAX_CHECKLIST_LINES_PER_ANGLE = 4;

const load = async () => (await loadDevLoopConfig({ repoRoot: mkdtempSync(path.join(os.tmpdir(), "issue-3396-")) })).config;

test("each A-line sits in its angle's checklist and the gate prompt", async () => {
  const config = await load();
  for (const [id, [angle, text]] of Object.entries(A_LINES)) {
    const line = config.gates.draft.angles.find((a) => a.name === angle)["developer-checklist"].find((l) => l.startsWith(`${id}: `));
    assert.ok(line?.includes(text), id);
    assert.ok(resolveReviewerRole(config, angle).prompt.includes(`- ${line}`), `${id} in the ${angle} prompt`);
  }
});

test("the developer brief and the gate prompt render the same config entry", async () => {
  const config = await load();
  for (const entry of config.gates.draft.angles.filter((a) => a["developer-checklist"])) {
    const prompt = resolveReviewerRole(config, entry.name).prompt;
    for (const line of entry["developer-checklist"]) assert.ok(prompt.includes(`- ${line}`), `${entry.name} ${line.slice(0, 3)}`);
  }
  // The developer-brief renderer reads the same entries and its lines appear in the gate prompts.
  const items = await resolveChecklistItems(mkdtempSync(path.join(os.tmpdir(), "issue-3396-")), ["scripts/a.mjs", "src/b.mjs", "skills/x.md", "package.json", "test/a.test.mjs"], { config });
  assert.ok(items.length > 0);
  for (const item of items) assert.ok(resolveReviewerRole(config, item.angle).prompt.includes(`- ${item.id}: ${item.check}`), item.id);
});

test("each angle's checklist stays within the line count and length bounds", async () => {
  const config = await load();
  for (const entry of config.gates.draft.angles.filter((a) => a["developer-checklist"])) {
    assert.ok(entry["developer-checklist"].length <= MAX_CHECKLIST_LINES_PER_ANGLE, entry.name);
    for (const line of entry["developer-checklist"]) assert.ok(line.length <= ANGLE_LINE_MAX, line);
  }
});

test("the pr-description prompt names the template headings Objective and In scope", async () => {
  const { prompt } = resolveReviewerRole(await load(), "pr-description");
  assert.match(prompt, /An Objective section/);
  assert.match(prompt, /An In scope section/);
  assert.doesNotMatch(prompt, /Summary section|Scope and context/);
});

test("a prompt-less angle entry renders the checklist alone in the gate prompt", () => {
  const config = { gates: { draft: { angles: [{ name: "x", persona: "p", "developer-checklist": ["X1: Check the thing"] }] } } };
  assert.match(resolveReviewerRole(config, "x").prompt, /- X1: Check the thing/);
});
