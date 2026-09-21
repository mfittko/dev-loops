import { assert, parseFrontmatter, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";
import { extractRelativeMarkdownLinks } from "../../scripts/docs/validate-links.mjs";

test("fresh reviewer configuration routes to the neutral-context and source-read owner", async () => {
  const owner = "skills/docs/gate-review-sub-loop-contract.md";
  assertRuleOwned("GATE-EXEC-BUILD-ONCE-SEED", owner);
  assertRuleOwned("GATE-EXEC-SOURCE-READ-WORKTREE", owner);
  const reviewer = await readRepo("agents/review.agent.md");
  assert.equal(parseFrontmatter(reviewer).defaultContext, "fresh");
  assert.ok(extractRelativeMarkdownLinks(reviewer).some(({ rawTarget }) =>
    rawTarget === "../skills/docs/gate-review-sub-loop-contract.md"));
  // Configuration/ownership are executable structure. No regex can establish
  // that a conductor withheld its conversation or that a reviewer read the
  // reviewed worktree. Sentinel/locality tests cover the mechanical guards;
  // those agent choices remain independent semantic-review scenarios.
});
