import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  detectModalityConflicts,
  detectNearDuplicates,
  extractRuleDefinitions,
  extractRuleReferences,
  extractTermDefinitions,
  extractTermUses,
  validateRuleOwnership,
} from "../../scripts/docs/validate-rule-ownership.mjs";

async function fixture(files, requiredRules = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-rule-ownership-"));
  await mkdir(path.join(dir, "skills", "docs"), { recursive: true });
  await writeFile(path.join(dir, "skills", "docs", "required-rules.json"), JSON.stringify({ requiredRules }, null, 2), "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, `${content}\n`, "utf8");
  }
  return dir;
}

test("extractRuleDefinitions reads rule markers", () => {
  const defs = extractRuleDefinitions("| <!-- rule: TEST-RULE-001 --> `TEST-RULE-001` | The tool MUST pass. |", "doc.md");
  assert.deepEqual(defs.map((d) => d.id), ["TEST-RULE-001"]);
  assert.match(defs[0].body, /MUST pass/);
});

test("extractRuleReferences reads comment refs and markdown ID links", () => {
  const refs = extractRuleReferences("<!-- rule-ref: TEST-RULE-001 --> see [TEST-RULE-002](x.md)", "doc.md");
  assert.deepEqual(refs.map((r) => r.id), ["TEST-RULE-001", "TEST-RULE-002"]);
});

test("term definitions and uses are detected in annotated docs", () => {
  const content = "<!-- term: state:blocked --> `blocked` means blocked.\n<!-- rule: TEST-RULE-001 --> `TEST-RULE-001` | The loop MUST stop at `waiting_for_review`. |";
  assert.deepEqual(extractTermDefinitions(content, "doc.md").map((t) => t.key), ["state:blocked"]);
  assert.deepEqual(extractTermUses(content, "doc.md").map((u) => u.token), ["waiting_for_review"]);
});

test("validateRuleOwnership fails duplicate rule definition", async () => {
  const dir = await fixture({
    "skills/docs/a.md": "<!-- rule: TEST-RULE-001 --> The loop MUST pass.",
    "skills/docs/b.md": "<!-- rule: TEST-RULE-001 --> The loop MUST pass again.",
  }, ["TEST-RULE-001"]);
  try {
    const result = await validateRuleOwnership(dir);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].kind, "duplicate_rule_definition");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateRuleOwnership fails unresolved reference", async () => {
  const dir = await fixture({
    "skills/docs/a.md": "<!-- rule-ref: MISSING-RULE-001 -->",
  });
  try {
    const result = await validateRuleOwnership(dir);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].kind, "unresolved_rule_reference");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateRuleOwnership fails missing manifest rule", async () => {
  const dir = await fixture({}, ["TEST-RULE-001"]);
  try {
    const result = await validateRuleOwnership(dir);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].kind, "required_rule_missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateRuleOwnership fails duplicate and undefined terms", async () => {
  const dir = await fixture({
    "skills/docs/a.md": "<!-- term: state:blocked --> `blocked` means blocked.\n<!-- term: state:blocked --> duplicate.\n<!-- rule: TEST-RULE-001 --> The loop MUST stop at `waiting_for_review`.",
  }, ["TEST-RULE-001"]);
  try {
    const result = await validateRuleOwnership(dir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.kind === "duplicate_term_definition"));
    assert.ok(result.errors.some((e) => e.kind === "undefined_term_use"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("near-duplicate and modality conflict scans are advisory helpers", () => {
  const defs = [
    { id: "A-001", body: "The agent MUST stop before merge." },
    { id: "A-002", body: "The agent MUST NOT stop before merge." },
  ];
  assert.equal(detectModalityConflicts(defs).length, 1);
  assert.equal(detectNearDuplicates([
    { id: "A-001", body: "The agent MUST stop before merge and report the gate." },
    { id: "A-002", body: "The agent SHOULD stop before merge and report the gate." },
  ]).length, 1);
});

test("repository rule ownership fixture is valid", async () => {
  const result = await validateRuleOwnership();
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});
