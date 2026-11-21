// Issue 3396 ac:3/ac:4: the A1-A8 angle lines, the pr-description headings and the single per-angle source.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDevLoopConfig, resolveReviewerRole } from "@dev-loops/core/config";
import { ANGLE_LINE_MAX } from "../../scripts/loop/_self-check-items.mjs";

const A_LINES = {
  A1: ["holistic", "For every state, artifact or route the diff produces, open its downstream validator"],
  A2: ["input-validation", "List the syntactic forms the real consumer accepts"],
  A3: ["state-concurrency", "retained versus live copies, interrupted writes, symlinks and stale remote refs"],
  A4: ["contract-surface", "Trace each refusal remedy and documented command through the target CLI parser"],
  A5: ["contract-surface", "Grep untouched skills/docs, docs/decisions, exit-code tables and JSDoc"],
  A6: ["determinism", "caller cwd, a checkout subdirectory, relative path arguments, inherited GIT_* env vars"],
  A7: ["packaging-runtime", "Claude-only tokens in shared skills/ or agents/ text"],
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
  // The pre-approval copy aliases the draft entry (YAML anchor), not a second text.
  for (const name of ["holistic", "contradiction-lens"]) {
    const pick = (gate) => config.gates[gate].angles.find((a) => a.name === name)["developer-checklist"];
    assert.deepEqual(pick("preApproval"), pick("draft"));
  }
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
