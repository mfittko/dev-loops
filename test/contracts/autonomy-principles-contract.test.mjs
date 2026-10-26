// ADR 0188: the autonomy principles are rules with one owner, a trigger, an actor, an outcome and a typed refusal code.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  "GATE-EXEC-FIXER-CYCLE-BOUND": "skills/docs/gate-review-sub-loop-contract.md",
};
const RULE_OUTCOME = {
  "GATE-EXEC-JUDGE-PRIME-AUTHORITY": /the judge decides it/,
  "GATE-EXEC-LOW-FIX-UNTIL-CAP": /At or past the cap it becomes `defer`/,
  "GATE-EXEC-OPERATOR-LINE-APPROVE-MERGE": /`merge-pr.mjs` refuses until it exists/,
  "GATE-EXEC-OPERATOR-LINE-RELEASE-PUBLISH": /no agent pushes a stable tag or publishes/,
  "ADR-OVER-WAIVER": /the orchestrator adds the ADR to the PR/,
  "GATE-EXEC-FIXER-CYCLE-BOUND": /the orchestrator dispatches another fixer cycle/,
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
    assert.match(text, RULE_OUTCOME[id], `${id} outcome`);
  }
  // Negative fixture: a rule line without its outcome clause fails the outcome check.
  assert.doesNotMatch(ruleText("ADR-OVER-WAIVER").replace("the orchestrator adds the ADR to the PR", ""), RULE_OUTCOME["ADR-OVER-WAIVER"]);
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

// A paraphrased restatement of a rule outcome is a second definition even when no verbatim body is pasted (AC10).
const OUTCOME_PHRASES = {
  "GATE-EXEC-LOW-FIX-UNTIL-CAP": [/at or past the cap\b.{0,80}\bdefer\b/i, /\bdefer\b.{0,80}at or past the cap\b/i, /\bfrom round 2\b.{0,80}\bnit\b/i, /\bnit\b.{0,80}\bfrom round 2\b/i, /\bis `act` below the round cap/i],
};

test("S1 rule outcome phrases appear under agents/ and skills/ only in the owning rule line", () => {
  const files = ["agents", "skills"].flatMap((dir) => readdirSync(new URL(`../../${dir}`, import.meta.url), { recursive: true }).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`));
  assert.ok(files.length > 10);
  for (const [id, phrases] of Object.entries(OUTCOME_PHRASES)) {
    const owner = ruleText(id);
    assert.ok(phrases.some((phrase) => phrase.test(owner)), `${id} owner line states its outcome`);
    for (const file of files) {
      for (const [n, line] of read(file).split("\n").entries()) {
        if (file === OWNERS[id] && line === owner) continue;
        for (const phrase of phrases) assert.doesNotMatch(line, phrase, `${file}:${n + 1} restates ${id}`);
      }
    }
  }
  // Negative fixture: the judge-brief wording this guard exists for is detected.
  assert.match("at or past the cap a `low` is `defer`", OUTCOME_PHRASES["GATE-EXEC-LOW-FIX-UNTIL-CAP"][0]);
});
