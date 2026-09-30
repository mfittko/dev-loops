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
