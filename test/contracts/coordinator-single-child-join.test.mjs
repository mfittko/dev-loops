import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const JOIN = "gate wait-for-units --artifact <hand-back path>";

test("COORDINATOR-SINGLE-CHILD-JOIN is registered and carries the no-turn-end and Pi sentences", () => {
  const contract = read("skills/docs/gate-review-sub-loop-contract.md");
  assert.ok(contract.includes("<!-- rule: COORDINATOR-SINGLE-CHILD-JOIN -->"));
  assert.ok(contract.indexOf("COORDINATOR-SINGLE-CHILD-JOIN -->") > contract.indexOf("rule: GATE-EXEC-HARNESS-JOIN"));
  assert.match(contract, /A coordinator never ends its turn while a single child runs, before the `--artifact` join returns\./);
  assert.match(contract, /Pi: the coordinator joins the child with a blocking dispatch \(`async: false`\), `runs\.all` or `bg_wait`.*`extension\/index\.ts` runs the foreground `async: false` child/);
  assert.ok(JSON.parse(read("skills/docs/required-rules.json")).requiredRules.some((rule) => rule.id === "COORDINATOR-SINGLE-CHILD-JOIN"));
});

test("the routed fixer and delta reviewer dispatch prose names the --artifact join command", () => {
  for (const file of ["skills/docs/gate-review-sub-loop-contract.md", "skills/docs/pre-pr-review-contract.md", "skills/local-implementation/SKILL.md", "skills/copilot-pr-followup/SKILL.md"]) {
    assert.ok(read(file).includes(JOIN), file);
  }
});
