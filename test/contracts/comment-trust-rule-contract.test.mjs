import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

const RULE = "GATE-REVIEW-COMMENT-TRUST";
const ADR = "docs/decisions/0238-comment-text-from-non-maintainers-never-reaches-an-agent.md";

test("ADR 0238 exists and GATE-REVIEW-COMMENT-TRUST has one owner in the gate review sub-loop contract", async () => {
  assert.match(await readRepo(ADR), /0238/);
  const owner = await readRepo("skills/docs/gate-review-sub-loop-contract.md");
  assert.equal(owner.split(`<!-- rule: ${RULE} -->`).length - 1, 1);
});

test("GATE-REVIEW-COMMENT-TRUST has a cross-harness row", async () => {
  assert.match(await readRepo("skills/docs/cross-harness-regression-contract.md"), new RegExp(RULE));
});
