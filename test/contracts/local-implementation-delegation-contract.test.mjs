import {
  assert,
  assertMatchesAll,
  readRepo,
  test,
} from "../imported-assets-helpers.mjs";
import { assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";
import { parseMarkdownSections } from "../../packages/core/src/loop/issue-refinement-artifact.mjs";
import { extractRelativeMarkdownLinks } from "../../scripts/docs/validate-links.mjs";

const SKILL_PATH = "skills/local-implementation/SKILL.md";

test("local-implementation skill owns the delegation table by rule ID", async () => {
  assertRulePresent("LOCAL-DELEGATION-TABLE");
  assertRuleOwned("LOCAL-DELEGATION-TABLE", SKILL_PATH);

  const content = await readRepo(SKILL_PATH);

  assertMatchesAll(content, [
    /## Task breakdown & delegation/i,
    /### Task decomposition/i,
    /### Delegation contract/i,
    /### Status monitoring/i,
    /### Consolidation/i,
  ], SKILL_PATH);

  // Structural check only: every delegate role must be present in the table,
  // not an exact restatement of each row's descriptive text.
  for (const role of ["developer", "quality", "docs", "fixer"]) {
    assert.match(content, new RegExp("\\|\\s*`" + role + "`\\s*\\|", "i"), `delegation table should route work to \`${role}\``);
  }
});

test("local-implementation skill does not reference the removed coordinator agent", async () => {
  const content = await readRepo(SKILL_PATH);

  assert.doesNotMatch(content, /coordinator/i);
});

test("local implementation delegates handoff derivation and lifecycle to their owners", async () => {
  const content = await readRepo(SKILL_PATH);
  const sections = parseMarkdownSections(content);
  const section = sections.find(({ bodyLines }) => bodyLines.some((line) => line.includes("../docs/workflow-handoff-contract.md")));
  assert.ok(section, "missing handoff owner");
  const body = section.bodyLines.join("\n");
  const links = extractRelativeMarkdownLinks(body).map(({ rawTarget }) => rawTarget);
  for (const owner of ["../docs/workflow-handoff-contract.md", "../docs/pr-lifecycle-contract.md"]) {
    assert.ok(links.includes(owner), `missing owner: ${owner}`);
  }
  for (const field of ["requiredReads", "nextAction"]) assert.ok(body.includes(`\`${field}\``));
  // The real envelope derivation/unknown-strategy checks live in handoff-envelope.test.mjs.
});

// Cross-harness regression guard: the developer implementation loop must
// perform one self-check and never a pre-pull-request review fan-out. This is
// shared harness-agnostic workflow text (no per-harness branch), so Pi, Claude,
// and Codex read the same sequence — satisfying cross-harness-regression-contract.md.
test("local-implementation developer loop prescribes no pre-PR gate fan-out (LOCAL-DEV-SELF-CHECK-NO-FANOUT)", async () => {
  assertRulePresent("LOCAL-DEV-SELF-CHECK-NO-FANOUT");
  assertRuleOwned("LOCAL-DEV-SELF-CHECK-NO-FANOUT", SKILL_PATH);

  const content = await readRepo(SKILL_PATH);
  const loopMatch = content.match(/## Implementation loop for the phase[\s\S]*?(?=\n## )/);
  assert.ok(loopMatch, "SKILL must contain an 'Implementation loop for the phase' section");
  const loop = loopMatch[0];

  // The developer step is a single self-check, never a reviewer fan-out.
  assertMatchesAll(loop, [
    /exactly one developer self-check/i,
    /MUST NOT dispatch review subagents/i,
  ], SKILL_PATH);

  // The removed pre-pull-request gate step is gone, not reworded: none of the
  // step-5 fan-out instructions survive as a developer-loop directive.
  assert.doesNotMatch(loop, /Run the default pre-approval gate as a full review/i);
  assert.doesNotMatch(loop, /resolve review angles from config/i);
  assert.doesNotMatch(loop, /run the resolved angle-focused passes/i);
  assert.doesNotMatch(loop, /resolveReviewerRole/);

  // Angle fan-out is bound to the two pull-request lifecycle gate boundaries.
  assertMatchesAll(loop, [
    /pull-request lifecycle activities only/i,
    /`draft_gate`/,
    /`pre_approval_gate`/,
    /only two lifecycle-gate fan-out sites/i,
    /conductor-owned/i,
  ], SKILL_PATH);

  // A local artifact is never lifecycle-gate evidence, and an incomplete review
  // is never clean.
  assert.match(loop, /NOT lifecycle-gate evidence/i);
  assert.match(loop, /gate-review-comment-contract\.md/i);
  assert.match(loop, /did not complete MUST NOT be summarized as clean/i);
});

test("local-implementation plan review stays a single artifact, not a reviewer fan-out", async () => {
  const content = await readRepo(SKILL_PATH);
  const sectionMatch = content.match(/### 5\. Review the merged phase plan adversarially[\s\S]*?(?=\n### |\n## )/);
  assert.ok(sectionMatch, "SKILL must contain the adversarial plan-review step");
  const section = sectionMatch[0];
  assert.match(section, /one local planning artifact/i);
  assert.match(section, /not a multi-reviewer fan-out/i);
});
