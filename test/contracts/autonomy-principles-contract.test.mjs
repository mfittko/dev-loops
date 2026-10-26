// ADR 0188: the autonomy principles are rules with one owner, a trigger, an actor, an outcome and a typed refusal code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const OWNERS = {
  "GATE-EXEC-JUDGE-PRIME-AUTHORITY": "skills/docs/gate-review-sub-loop-contract.md",
  "GATE-EXEC-LOW-NIT-NEVER-BLOCKS": "skills/docs/gate-review-sub-loop-contract.md",
  "GATE-EXEC-OPERATOR-LINE-APPROVE-MERGE": "skills/docs/gate-review-sub-loop-contract.md",
  "GATE-EXEC-OPERATOR-LINE-RELEASE-PUBLISH": "skills/docs/gate-review-sub-loop-contract.md",
  "ADR-OVER-WAIVER": "skills/docs/decision-record-contract.md",
  "PLAN-SPLIT-BEFORE-OVERSIZE": "skills/docs/local-planning.md",
};
const ruleText = (id) => read(OWNERS[id]).split("\n").find((l) => l.startsWith(`\`${id}\``) || l.includes(`rule: ${id} --> \`${id}\``));

test("each rule has one owner, no loose modal wording and names a trigger, actor and outcome", () => {
  for (const id of Object.keys(OWNERS)) {
    const text = ruleText(id);
    assert.ok(text, id);
    assert.doesNotMatch(text, /\b(should|may|usually|where appropriate)\b/i, id);
    assert.match(text, /\b(When|If)\b/, `${id} trigger`);
    assert.match(text, /\b(judge|orchestrator|operator|refiner|`applyJudgeDispositions`)\b/, `${id} actor`);
    assert.match(text, /ADR 0188 records this rule|#2756/, id);
  }
});

test("remaining operator lines state why the judge cannot decide them", () => {
  for (const id of ["GATE-EXEC-OPERATOR-LINE-APPROVE-MERGE", "GATE-EXEC-OPERATOR-LINE-RELEASE-PUBLISH"]) {
    assert.match(ruleText(id), /The judge cannot decide this[^.]* because /, id);
  }
});

test("the low/nit refusal and coercion code is pinned to the rule text", async () => {
  const text = ruleText("GATE-EXEC-LOW-NIT-NEVER-BLOCKS");
  assert.match(text, /`low_nit_never_blocks`/);
  const code = "low_nit_never_blocks";
  assert.match(read("scripts/loop/emit-fixer-work-order.mjs"), new RegExp(`"${code}", \`${code} \\(GATE-EXEC-LOW-NIT-NEVER-BLOCKS\\)`));
  assert.match(read("packages/core/src/loop/gate-fanin.mjs"), new RegExp(`${code} \\(GATE-EXEC-LOW-NIT-NEVER-BLOCKS\\)`));
});
