// ADR 0188: the autonomy principles are rules with one owner, a trigger, an actor, an outcome and a typed refusal code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";

import { collectContractMarkdownFiles, extractRuleDefinitions, findEmbeddedRuleBodies } from "../../scripts/docs/validate-rule-ownership.mjs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const OWNERS = {
  "GATE-EXEC-JUDGE-PRIME-AUTHORITY": "skills/docs/gate-review-sub-loop-contract.md",
  "GATE-EXEC-LOW-FIX-UNTIL-CAP": "skills/docs/gate-review-sub-loop-contract.md",
  "GATE-EXEC-OPERATOR-LINE-APPROVE-MERGE": "skills/docs/gate-review-sub-loop-contract.md",
  "GATE-EXEC-OPERATOR-LINE-RELEASE-PUBLISH": "skills/docs/gate-review-sub-loop-contract.md",
  "ADR-OVER-WAIVER": "skills/docs/decision-record-contract.md",
  "PLAN-SPLIT-BEFORE-OVERSIZE": "skills/docs/local-planning.md",
  "GATE-EXEC-FIXER-CYCLE-BOUND": "skills/docs/gate-review-sub-loop-contract.md",
};
const ruleText = (id) => read(OWNERS[id]).split("\n").find((l) => l.startsWith(`\`${id}\``) || l.includes(`rule: ${id} --> \`${id}\``));

test("no S1 rule has a second definition or an embedded body outside its owner", async () => {
  const sources = (await collectContractMarkdownFiles()).map((file) => ({ file, content: readFileSync(file, "utf8") }));
  const ids = new Set(Object.keys(OWNERS));
  const defs = sources.flatMap(({ file, content }) => extractRuleDefinitions(content, file)).filter((def) => ids.has(def.id));
  for (const id of ids) {
    assert.deepEqual(defs.filter((def) => def.id === id).map((def) => def.file.split(path.sep).join("/")).map((f) => f.slice(f.indexOf(OWNERS[id]))), [OWNERS[id]], `${id} has exactly one definition, in its owner`);
  }
  const embedded = (text, own) => findEmbeddedRuleBodies(text, sources).filter((def) => ids.has(def.id) && def.file !== own).map((def) => def.id);
  for (const { file, content } of sources) assert.deepEqual(embedded(content, file), [], `${file} embeds an S1 rule body`);
  // Negative fixture: a pasted S1 rule body is detected; a bare citation is not.
  const [pasted] = defs;
  assert.deepEqual(embedded(`See \`${pasted.id}\`.`, "x.md"), []);
  assert.deepEqual(embedded(`${pasted.body}`, "x.md"), [pasted.id]);
});

test("each rule has an owner-line with no loose modal wording that names a trigger, actor and outcome", () => {
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
  const text = ruleText("GATE-EXEC-LOW-FIX-UNTIL-CAP");
  assert.match(text, /`low_fix_until_cap`/);
  const code = "low_fix_until_cap";
  assert.match(read("scripts/loop/emit-fixer-work-order.mjs"), new RegExp(`"${code}", \`${code} \\(GATE-EXEC-LOW-FIX-UNTIL-CAP\\)`));
  assert.match(read("packages/core/src/loop/gate-fanin.mjs"), new RegExp(`${code} \\(GATE-EXEC-LOW-FIX-UNTIL-CAP\\)`));
});
