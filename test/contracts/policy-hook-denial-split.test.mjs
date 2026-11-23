import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";

const RULE = "OPS-POLICY-HOOK-DENIAL-RECOVERABLE";
const OWNER = "skills/docs/copilot-loop-operations.md";
const ROLE_FILES = [
  "agents/fixer.agent.md",
  "agents/developer.agent.md",
  "agents/review.agent.md",
  "agents/judge.agent.md",
  "agents/gate-coordinator.agent.md",
  "agents/dev-loop.agent.md",
  "skills/dev-loop/SKILL.md",
];

test("the owner doc states the fail-open split, both stops and the recovery", async () => {
  assertRuleOwned(RULE, OWNER);
  assertRuleOwned("OPS-NO-TIMEOUT-WRAPPER", OWNER);
  const doc = await readRepo(OWNER);
  const rule = doc.slice(doc.indexOf(`\`${RULE}\`:`)).split("\n")[0];
  for (const phrase of [
    "policy-hook: <rule-id>; compliant form: <text>",
    "runs the compliant form the marker names, once",
    "Any denial of the compliant-form attempt stops the actor",
    "A denial without the `policy-hook:` marker line stops the actor immediately",
    "the actor quotes the denial text verbatim, and the orchestrator decides with the operator",
  ]) {
    assert.ok(rule.includes(phrase), `${RULE} text is missing: ${phrase}`);
  }
});

test("each role surface cites the rule and still states the permission or classifier stop", async () => {
  for (const file of ROLE_FILES) {
    const text = await readRepo(file);
    assert.ok(text.includes(RULE), `${file} must cite ${RULE}`);
    assert.match(text, /permission or classifier denial/, `${file} must keep the permission or classifier stop`);
  }
});

test("the old unscoped stop wording is gone and the runner stop condition stays", async () => {
  const fixer = await readRepo("agents/fixer.agent.md");
  const skill = await readRepo("skills/dev-loop/SKILL.md");
  assert.ok(!fixer.includes("A permission or classifier denial stops this actor immediately"), "fixer bullet is still unscoped");
  const workOrder = await readRepo("scripts/loop/emit-fixer-work-order.mjs");
  assert.ok(!workOrder.includes("A permission or classifier denial stops this actor immediately"), "fixer work order is still unscoped");
  assert.ok(!skill.includes("does not retry the denied call in any command form"), "dev-loop skill sentence is still unscoped");
  assert.ok(skill.includes("- a harness permission or classifier denial, or an interruption."), "DEV-LOOP-RUNNER-STOP-CONDITIONS stop bullet is missing");
});
