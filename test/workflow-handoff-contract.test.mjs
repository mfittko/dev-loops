import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";

const templatePath = path.resolve("skills/docs/workflow-handoff-contract.md");

let templateContent = null;

async function readTemplate() {
  if (templateContent === null) {
    templateContent = await readFile(templatePath, "utf8");
  }
  return templateContent;
}

test("workflow-handoff-contract exists and is non-empty", async () => {
  const content = await readTemplate();
  assert.ok(content.length > 100, "template should have substantial content");
});

test("workflow-handoff-contract declares itself as a derivation contract", async () => {
  const content = await readTemplate();
  assert.match(content, /derivation contract/i);
  assert.match(content, /buildDevLoopHandoffEnvelope/);
});

test("workflow-handoff-contract documents three authoritative sources", async () => {
  const content = await readTemplate();

  assert.match(content, /Resolver output/i);
  assert.match(content, /resolve-dev-loop-startup/);
  assert.match(content, /Settings/i);
  assert.match(content, /\.devloops/);
  assert.match(content, /Gate state/i);
});

test("workflow-handoff-contract includes acceptance template table", async () => {
  const content = await readTemplate();

  // Each strategy+gate combo must be documented
  assert.match(content, /copilot_pr_followup.*draft/i);
  assert.match(content, /copilot_pr_followup.*watch/i);
  assert.match(content, /copilot_pr_followup.*pre-approval/i);
  assert.match(content, /final_approval/i);
  assert.match(content, /local_implementation/i);
  assert.match(content, /issue_intake/i);
});

test("workflow-handoff-contract documents stop rules derivation", async () => {
  const content = await readTemplate();

  assert.match(content, /stop rules/i);
  assert.match(content, /autonomy\.stopAt/);
  assert.match(content, /strategy defaults/i);
});

test("workflow-handoff-contract includes envelope schema", async () => {
  const content = await readTemplate();

  assert.match(content, /handoffVersion:\s*1/);
  assert.match(content, /derivedAt/);
  // Check for target block with repo field (may span lines in TypeScript)
  assert.match(content, /target:\s*\{/);
  assert.match(content, /repo:\s*string/);
  assert.match(content, /acceptance:\s*\{/);
  assert.match(content, /criteria:\s*Array/);
  assert.match(content, /control:\s*\{/);
  assert.match(content, /needsAttentionAfterMs:\s*number/);
});

test("workflow-handoff-contract documents agent consumption pattern", async () => {
  const content = await readTemplate();

  assert.match(content, /Agent consumption pattern/i);
  assert.match(content, /Read the handoff envelope/i);
  assert.match(content, /requiredReads/);
  assert.match(content, /nextAction/);
});

test("workflow-handoff-contract includes backward compatibility note", async () => {
  const content = await readTemplate();

  assert.match(content, /Backward compatibility/i);
  assert.match(content, /acceptance.*block.*1:1/i);
  assert.match(content, /subagent/);
});

test("workflow-handoff-contract lists non-goals", async () => {
  const content = await readTemplate();

  assert.match(content, /Non-goals/i);
  assert.match(content, /dispatch mechanics/i);
  assert.match(content, /UI\/UX/i);
});

test("workflow-handoff-contract mentions unknown combos throw explicit errors", async () => {
  const content = await readTemplate();

  assert.match(content, /Unknown strategy.*gate combinations throw/i);
});
