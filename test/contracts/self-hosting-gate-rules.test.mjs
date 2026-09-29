// ADR 0117: the self-hosting gate rules live in their canonical docs and state the two-step rollout,
// the self-gate grill question and the launcher flag form.
import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";

const collapse = (text) => text.replace(/\s+/g, " ");
function ruleParagraph(content, id) {
  const marker = `<!-- rule: ${id} -->`;
  const start = content.indexOf(marker);
  assert.ok(start !== -1, `expected ${marker}`);
  const end = content.indexOf("\n\n", start);
  return collapse(content.slice(start, end === -1 ? content.length : end));
}

test("GATE-SELF-HOST-EXPAND-CONTRACT and GRILL-SELF-HOST-PATH are registered and owned", async () => {
  const manifest = JSON.parse(await readRepo("skills/docs/required-rules.json"));
  for (const [id, owner] of [
    ["GATE-SELF-HOST-EXPAND-CONTRACT", "skills/docs/gate-review-sub-loop-contract.md"],
    ["GRILL-SELF-HOST-PATH", "skills/loop-grill/SKILL.md"],
  ]) {
    assertRulePresent(id);
    assertRuleOwned(id, owner);
    assert.ok(manifest.requiredRules.some((rule) => rule.id === id), `expected ${id} in required-rules.json`);
  }
});

test("GATE-SELF-HOST-EXPAND-CONTRACT names step 1, step 2 and the session hooks", async () => {
  const rule = ruleParagraph(await readRepo("skills/docs/gate-review-sub-loop-contract.md"), "GATE-SELF-HOST-EXPAND-CONTRACT");
  assert.match(rule, /a change to a shape that a session hook or a main-checkout script consumes MUST land in two steps/);
  assert.match(rule, /Step 1 makes every consumer accept both the old and the new shape/);
  assert.match(rule, /Step 2 switches the producer and drops the old shape/);
  assert.match(rule, /The session hooks always load from the main checkout/);
});

test("GRILL-SELF-HOST-PATH asks both self-gate questions and records a hard cut", async () => {
  const rule = ruleParagraph(await readRepo("skills/loop-grill/SKILL.md"), "GRILL-SELF-HOST-PATH");
  assert.match(rule, /for each changed producer\/consumer pair/);
  assert.match(rule, /which checkout runs each side during the PR's own gate\?/);
  assert.match(rule, /does the main-checkout side accept the output of the PR-head side\?/);
  assert.match(rule, /A hard-cut decision records both answers in the grill results/);
});

test("WORKTREE-SCRIPT-LAUNCHER-CWD names the --repo-root form and the bare pull line", async () => {
  const doc = await readRepo("skills/docs/worktree-guidance.md");
  const start = doc.indexOf("<!-- rule: WORKTREE-SCRIPT-LAUNCHER-CWD -->");
  const rule = collapse(doc.slice(start, doc.indexOf("\n## ", start)));
  // The MUST headline itself names both sanctioned forms and the bare pull line exemption.
  assert.ok(rule.includes("`cd <checkout> && dev-loops-run scripts/<path>`, or as `dev-loops-run --repo-root <checkout> scripts/<path>`. A dispatched pull line is exempt and runs bare."));
  assert.match(rule, /A dispatched pull line runs bare, exactly as dispatched, and is never prefixed with `cd`\./);
});
