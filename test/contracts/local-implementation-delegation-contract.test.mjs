import {
  assert,
  assertMatchesAll,
  readRepo,
  test,
} from "../imported-assets-helpers.mjs";
import { assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";

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

test("local-implementation skill owns workflow handoff template delegation", async () => {
  const content = await readRepo(SKILL_PATH);

  assert.match(content, /`local-implementation` skill uses this template when delegating/i);
  assert.doesNotMatch(content, /coordinator must use this template/i);
});
