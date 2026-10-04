import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const collapse = (text) => text.replace(/\s+/g, " ");

function ruleBlock(content, id) {
  const start = content.indexOf(`<!-- rule: ${id} -->`);
  assert.ok(start !== -1, `${id} marker present`);
  const rest = content.slice(start + 1);
  const end = rest.indexOf("<!-- rule:");
  return collapse(end === -1 ? rest : rest.slice(0, end));
}

test("reviewer style rule states the seven output rules and references the deslop step", () => {
  const block = ruleBlock(read("skills/docs/gate-review-comment-contract.md"), "GATE-COMMENT-REVIEWER-STYLE");
  for (const phrase of [
    "Lead with the point.",
    "Give one action per recommendation. Use numbered steps for more than one action.",
    "Write no preamble, recap or closer.",
    "Cap every list at five ranked items.",
    "Use a matter-of-fact tone.",
    "pre-send check that deletes every announcing, recapping and hedging sentence",
    "Apply the deslop style at write time",
    "(./ab-contrast-deslop-step.md)",
  ]) {
    assert.ok(block.includes(phrase), `missing: ${phrase}`);
  }
  assert.ok(fs.existsSync(path.join(repoRoot, "skills/docs/ab-contrast-deslop-step.md")));
});

test("the reviewer agent points at the style rule", () => {
  assert.match(read("agents/review.agent.md"), /GATE-COMMENT-REVIEWER-STYLE/);
});

test("the inline layout rule names the layout, the pointer and the merge", () => {
  const block = ruleBlock(read("skills/docs/gate-review-comment-contract.md"), "GATE-COMMENT-INLINE-LAYOUT");
  for (const phrase of ["**Problem:**", "**Failing case:**", "**Fix:**", "Full text: ledger entry", "one marker per merged finding"]) {
    assert.ok(block.includes(phrase), `missing: ${phrase}`);
  }
});

test("the inline layout rule states the key-based same-defect rule and the carrier exception matches it", () => {
  const content = read("skills/docs/gate-review-comment-contract.md");
  const block = ruleBlock(content, "GATE-COMMENT-INLINE-LAYOUT");
  for (const phrase of [
    "both findings carry an equal `defectKey`",
    "neither carries one and their normalized summaries are identical",
    "A `defectKey` on only one of the two findings blocks the merge.",
    "A finding with no file never merges.",
    "The `defectKey` never renders and never enters the fingerprint or the marker.",
    "`**Problem (<angle>):**`",
    "`**Fix (<angle>):**`",
    "Non-locatable findings merge by the same rule into one body-only bullet",
  ]) {
    assert.ok(block.includes(phrase), `missing: ${phrase}`);
  }
  assert.doesNotMatch(block, /at least five words|40%/);
  assert.ok(collapse(content).includes("a same-defect merged comment or bullet carries its members together and renders each distinct summary once"));
});

// Structural claim check. A claim is a list of literal tokens (rule IDs, flags, fields, RFC-2119 modalities)
// that must co-occur in ONE sentence of the located block, so rewording keeps passing and a dropped literal
// or modality fails. `assertClaims` also proves both directions on the real block: a reworded copy (filler clause between tokens, sentence order reversed) passes,
// and removing a claim's last token makes exactly that claim fail.
const sentences = (text) => collapse(text).split(/(?<=[.!?:])\s+(?=[A-Z`*(|-])/);
const POLARITY = { optional: /(?<!not |never |non-)\boptional\b/ };
const has = (s, t) => (POLARITY[t] ? POLARITY[t].test(s) : s.includes(t));
const missingClaims = (block, claims) => claims.filter((tokens) => !sentences(block).some((s) => tokens.every((t) => has(s, t))));
const reword = (block, claims) => sentences(block).map((s) => (claims.find((tokens) => tokens.every((t) => has(s, t)))?.slice(0, -1) ?? []).reduce((acc, t) => acc.replace(t, `${t} (as the contract records, without exception)`), s)).reverse().join(" ");
function assertClaims(block, claims, label) {
  assert.deepEqual(missingClaims(block, claims), [], `${label}: missing claim`);
  assert.deepEqual(missingClaims(reword(block, claims), claims), [], `${label}: a reworded copy must pass`);
  for (const tokens of claims) {
    const broken = collapse(block).split(tokens.at(-1)).join("");
    assert.ok(missingClaims(broken, claims).includes(tokens), `${label}: dropping ${tokens.at(-1)} must fail ${tokens.join(" + ")}`);
  }
}

test("the reviewer agent's findings shape carries the optional defectKey and when to set it", () => {
  const agent = collapse(read("agents/review.agent.md"));
  assert.match(agent, /"defectKey": "<rule ID or AC row label>"/);
  assertClaims(agent, [["`defectKey`", "optional"]], "reviewer agent defectKey");
  assert.match(agent, /\^\[A-Za-z0-9\._:-\]\{1,64\}\$/);
});
