import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  detectDuplicateImperativeSentences,
  detectModalityConflicts,
  detectNearDuplicates,
  extractImperativeSentences,
  extractRuleDefinitions,
  extractRuleReferences,
  extractTermDefinitions,
  extractTermUses,
  isImperativeSentence,
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

test("near-duplicate and modality conflict scan helpers detect findings", () => {
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

test("modality conflict scan is order-insensitive (gating must not depend on file-walk order)", () => {
  const mustFirst = [
    { id: "A-001", body: "The agent MUST stop before merge." },
    { id: "A-002", body: "The agent SHOULD stop before merge." },
  ];
  const shouldFirst = [...mustFirst].reverse();
  assert.equal(detectModalityConflicts(mustFirst).length, 1, "MUST-then-SHOULD downgrade must be flagged");
  assert.equal(detectModalityConflicts(shouldFirst).length, 1, "SHOULD-then-MUST (reverse order) must be flagged identically");
  const threeWay = [
    { id: "B-001", body: "The loop MAY retry the request." },
    { id: "B-002", body: "The loop MUST retry the request." },
    { id: "B-003", body: "The loop MUST NOT retry the request." },
  ];
  assert.ok(detectModalityConflicts(threeWay).length >= 2, "all conflicting pairs in a subject group are reported");
});

test("modality conflict scan catches MUST NOT vs SHOULD NOT negative-pair downgrade (both orders)", () => {
  const mustNotFirst = [
    { id: "C-001", body: "The agent MUST NOT merge without a clean gate." },
    { id: "C-002", body: "The agent SHOULD NOT merge without a clean gate." },
  ];
  const shouldNotFirst = [...mustNotFirst].reverse();
  assert.equal(detectModalityConflicts(mustNotFirst).length, 1, "MUST NOT-then-SHOULD NOT downgrade must be flagged");
  assert.equal(detectModalityConflicts(shouldNotFirst).length, 1, "SHOULD NOT-then-MUST NOT (reverse order) must be flagged identically");
});

test("modality conflict scan treats SHALL/SHALL NOT as strong forms (RFC 2119 equivalence)", () => {
  assert.equal(detectModalityConflicts([
    { id: "D-001", body: "The agent SHALL stop before merge." },
    { id: "D-002", body: "The agent SHOULD stop before merge." },
  ]).length, 1, "SHALL vs SHOULD downgrade must be flagged");
  assert.equal(detectModalityConflicts([
    { id: "E-001", body: "The agent SHALL NOT merge without a clean gate." },
    { id: "E-002", body: "The agent SHOULD NOT merge without a clean gate." },
  ]).length, 1, "SHALL NOT vs SHOULD NOT downgrade must be flagged");
  assert.equal(detectModalityConflicts([
    { id: "F-001", body: "The agent SHALL stop before merge." },
    { id: "F-002", body: "The agent MUST stop before merge." },
  ]).length, 0, "two strong positive forms are not a conflict");
});

test("validateRuleOwnership gates on a modality conflict (no longer advisory)", async () => {
  const dir = await fixture({
    "skills/docs/a.md": "<!-- rule: TEST-RULE-001 --> `TEST-RULE-001` | The agent MUST stop before merge and report the gate. |",
    "skills/docs/b.md": "<!-- rule: TEST-RULE-002 --> `TEST-RULE-002` | The agent SHOULD stop before merge and report the gate. |",
  }, ["TEST-RULE-001", "TEST-RULE-002"]);
  try {
    const result = await validateRuleOwnership(dir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.kind === "modality_conflict"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isImperativeSentence detects must/never/do not/require", () => {
  assert.ok(isImperativeSentence("You must always run tests before every push."));
  assert.ok(isImperativeSentence("Never push directly to the main branch."));
  assert.ok(isImperativeSentence("Do not bypass the gate check mechanism."));
  assert.ok(isImperativeSentence("This step requires explicit verification."));
  assert.ok(!isImperativeSentence("This is a simple statement."));
});

test("extractImperativeSentences skips fenced code and headings", () => {
  const content = ["# Required Startup Reads", "You must read the documentation before starting.", "```", "You must also check this inside code block.", "```"].join("\n");
  const result = extractImperativeSentences(content);
  assert.equal(result.length, 1);
  assert.ok(result[0].text.includes("read the documentation"));
});

test("detectDuplicateImperativeSentences flags cross-file duplicates", () => {
  const findings = detectDuplicateImperativeSentences([
    { file: "skills/doc-a/SKILL.md", content: "You must always run tests before pushing changes to main." },
    { file: "skills/doc-b/SKILL.md", content: "You must always run tests before pushing changes to main." },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "duplicate_imperative_sentence");
});

test("detectDuplicateImperativeSentences ignores known intentional duplicates", () => {
  const findings = detectDuplicateImperativeSentences([
    { file: "commands/loop-auto.command.md", content: "Do not pick an internal strategy name yourself." },
    { file: "commands/loop-start.command.md", content: "Do not pick an internal strategy name yourself." },
  ]);
  assert.equal(findings.length, 0);
});

test("validateRuleOwnership gates on a duplicated imperative sentence", async () => {
  const dir = await fixture({
    "skills/docs/a.md": "You must always run tests before pushing changes to main.",
    "agents/b.agent.md": "You must always run tests before pushing changes to main.",
  });
  try {
    const result = await validateRuleOwnership(dir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.kind === "duplicate_imperative_sentence"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository rule ownership fixture is valid", async () => {
  const result = await validateRuleOwnership();
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});
