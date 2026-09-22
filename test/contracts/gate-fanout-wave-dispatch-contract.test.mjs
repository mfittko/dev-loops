import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { parseMarkdownSections } from "../../packages/core/src/loop/issue-refinement-artifact.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";

const CONTRACT_PATH = "skills/docs/gate-review-sub-loop-contract.md";
const WAVE_RULE = "GATE-EXEC-FANOUT-WAVE-DISPATCH";
const WAVE_MARKER = `<!-- rule: ${WAVE_RULE} -->`;

// Slice the rule's OWN owner section: from its marker to the next rule marker.
function waveRuleSection(content) {
  const lines = parseMarkdownSections(content).find(({ bodyLines }) => bodyLines.includes(WAVE_MARKER))?.bodyLines;
  assert.ok(lines, `${WAVE_RULE} owner section must exist`);
  const tail = lines.slice(lines.indexOf(WAVE_MARKER) + 1);
  const boundary = tail.findIndex((line) => /^<!-- rule:/.test(line));
  return tail.slice(0, boundary < 0 ? undefined : boundary).join("\n");
}

// AC-6: the wave-dispatch rule states the ONE-call-per-wave shape and never
// presents the legacy `tasks:` input as an available option. A reword that
// drops the one-call shape or that presents `tasks:` as valid must fail.
function assertWaveDispatchOneCallShape(section) {
  for (const token of ["workflowScriptPath", "runs.all", "ONE call per wave"]) {
    assert.ok(section.includes(token), `${WAVE_RULE} must state the one-call shape: ${token}`);
  }
  for (const line of section.split("\n").filter((line) => /tasks\s*:/.test(line))) {
    assert.match(line, /\bNOT\b|\bnever\b|\brejected\b|\bremoved\b|\bnot available\b/i,
      `${WAVE_RULE} must present \`tasks:\` only as a rejected shape`);
    assert.doesNotMatch(line, /\bis\s+(an?\s+)?(available|valid|supported|an option)\b/i,
      `${WAVE_RULE} must never present \`tasks:\` as an available option`);
  }
}

test("the wave-dispatch rule owns the ONE-call-per-wave shape and rejects tasks: as an option", async () => {
  assertRuleOwned(WAVE_RULE, CONTRACT_PATH);
  const owner = await readRepo(CONTRACT_PATH);
  const section = waveRuleSection(owner);
  assertWaveDispatchOneCallShape(section);
  // A reword that drops any part of the one-call shape fails.
  assert.throws(() => assertWaveDispatchOneCallShape(section.replaceAll("workflowScriptPath", "workflowScript")));
  assert.throws(() => assertWaveDispatchOneCallShape(section.replaceAll("runs.all", "runs.parallel")));
  assert.throws(() => assertWaveDispatchOneCallShape(section.replaceAll("ONE call per wave", "one call per unit")));
  // A reword that presents `tasks:` as valid (drops the negation) fails.
  assert.throws(() => assertWaveDispatchOneCallShape(section.replaceAll("is NOT an available shape", "is an available shape")));
});

test("the SKILL.md dispatch-discipline paragraph carries the one-call shape", async () => {
  const skill = await readRepo("skills/dev-loop/SKILL.md");
  const paragraph = skill.split(/\n{2,}/).find((p) => p.includes("Gate fan-out dispatch discipline"));
  assert.ok(paragraph, "the dispatch-discipline paragraph must exist");
  for (const token of ["workflowScriptPath", "runs.all", "ONE call per wave"]) {
    assert.ok(paragraph.includes(token), `dispatch-discipline paragraph must carry the one-call shape: ${token}`);
  }
});

// AC-6 names TWO surfaces: the SKILL.md dispatch guidance AND the per-harness
// delivery table. Reverting that table's Code-driven Pi row to the old
// "driver reads the file and directly supplies the spawned reviewer's prompt"
// wording must fail.
test("the per-harness delivery table's Code-driven Pi row carries the one-call shape", async () => {
  const contract = await readRepo(CONTRACT_PATH);
  const row = contract.split("\n").find((line) => line.startsWith("| Code-driven Pi"));
  assert.ok(row, "the delivery table must carry a `| Code-driven Pi` row");
  for (const token of ["workflowScriptPath", "ONE `subagent` call per wave", "Never one call per unit"]) {
    assert.ok(row.includes(token), `the Code-driven Pi row must carry: ${token}`);
  }
});
