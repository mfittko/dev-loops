import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";
import { extractRelativeMarkdownLinks } from "../../scripts/docs/validate-links.mjs";

function assertAdversarialOwnerReference(content) {
  assert.ok(content.includes("COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING"));
  assert.ok(extractRelativeMarkdownLinks(content).some(({ rawTarget }) =>
    rawTarget === "../skills/copilot-pr-followup/SKILL.md"));
}

test("scoped reviewers reference the single adversarial-briefing owner", async () => {
  assertRuleOwned("COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING", "skills/copilot-pr-followup/SKILL.md");
  assertAdversarialOwnerReference(await readRepo("agents/review.agent.md"));
  // Full-diff fallback and meaningful contextWidened attribution are agent
  // duties. Context/prompt tests cover supplied bytes and pointers; neither
  // keyword matching nor owner discovery proves that a reviewer finds bugs.
});

test("adversarial-owner discovery survives wording changes and refuses broken routing", () => {
  for (const label of ["Review behavior", "Required reviewing instructions"]) {
    const reference = `Follow COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING in\n[${label}](../skills/copilot-pr-followup/SKILL.md).`;
    assertAdversarialOwnerReference(reference);
    assert.throws(() => assertAdversarialOwnerReference(reference.replace("COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING", "unowned advice")));
    assert.throws(() => assertAdversarialOwnerReference(reference.replace("../skills/copilot-pr-followup/SKILL.md", "../skills/other/SKILL.md")));
  }
});
