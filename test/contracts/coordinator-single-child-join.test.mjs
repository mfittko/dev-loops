import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const JOIN = "gate wait-for-units --artifact <hand-back path>";

test("COORDINATOR-SINGLE-CHILD-JOIN is registered and carries the no-turn-end and Pi sentences", () => {
  const contract = read("skills/docs/gate-review-sub-loop-contract.md");
  assert.ok(contract.includes("<!-- rule: COORDINATOR-SINGLE-CHILD-JOIN -->"));
  assert.ok(contract.indexOf("COORDINATOR-SINGLE-CHILD-JOIN -->") > contract.indexOf("rule: GATE-EXEC-HARNESS-JOIN"));
  assert.match(contract, /The hand-back path must not exist at dispatch: each fixer emission and each delta review invocation gets its own path, and the coordinator never reuses a hand-back path\./);
  assert.match(contract, /only for a final hand-back: the file parses as JSON and the completed marker `<hand-back path>\.done` exists\. The child writes the hand-back path and then the marker as its last action/);
  assert.match(read("docs/decisions/0216-slice-a-cap-round-chain-and-single-child-join.md"), /only for a final hand-back/);
  assert.match(contract, /A coordinator never ends its turn while a single child runs, before the `--artifact` join returns\./);
  assert.match(contract, /Pi: the coordinator joins the child with a blocking dispatch \(`async: false`\), `runs\.all` or `bg_wait`.*`extension\/index\.ts` runs the foreground `async: false` child/);
  assert.ok(JSON.parse(read("skills/docs/required-rules.json")).requiredRules.some((rule) => rule.id === "COORDINATOR-SINGLE-CHILD-JOIN"));
});

test("the routed fixer and delta reviewer dispatch prose names the --artifact join command", () => {
  for (const file of ["skills/docs/gate-review-sub-loop-contract.md", "skills/docs/pre-pr-review-contract.md", "skills/local-implementation/SKILL.md", "skills/copilot-pr-followup/SKILL.md", "skills/dev-loop/SKILL.md", "agents/dev-loop.agent.md"]) {
    assert.ok(read(file).includes(JOIN), file);
  }
});

test("the harness-join bullet and the dev-loop agent no longer join the fixer through the completion notification", () => {
  for (const file of ["skills/docs/gate-review-sub-loop-contract.md", "agents/dev-loop.agent.md"]) {
    const text = read(file);
    assert.doesNotMatch(text, /developer and fixer/, file);
    assert.doesNotMatch(text, /developer or fixer completion notification/, file);
    assert.ok(text.includes("COORDINATOR-SINGLE-CHILD-JOIN"), file);
  }
});

test("the Copilot follow-up THREAD-route delta reviewer dispatch sentence names the --artifact join", () => {
  const text = read("skills/copilot-pr-followup/SKILL.md");
  const at = text.indexOf("Otherwise run the delta reviewer");
  assert.ok(at >= 0);
  assert.ok(text.slice(at, at + 400).includes("gate wait-for-units --artifact <the delta reviewer's `--result` path>"));
});
