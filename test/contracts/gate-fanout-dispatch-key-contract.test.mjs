import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { evaluateInlineFanoutMode } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { parseMarkdownSections } from "../../packages/core/src/loop/issue-refinement-artifact.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";

// The requirement is the owner rule's first sentence, located by the rule marker.
function dispatchKeyRequirement(content) {
  const marker = "<!-- rule: GATE-EXEC-FANOUT-DISPATCH-KEY -->";
  const lines = parseMarkdownSections(content).find(({ bodyLines }) => bodyLines.includes(marker))?.bodyLines;
  assert.ok(lines, "dispatch-key owner section must exist");
  const tail = lines.slice(lines.indexOf(marker) + 1);
  const boundary = tail.findIndex((line) => !line.trim() || /^<!-- rule:/.test(line));
  return tail.slice(0, boundary < 0 ? undefined : boundary).join(" ")
    .split(/\.(?=\s|$)/, 1)[0].replace(/\s+/g, " ");
}

function assertDispatchKeyRequirement(content) {
  const requirement = dispatchKeyRequirement(content);
  for (const token of ["`runs.all`", "`key`"]) assert.ok(requirement.includes(token), `missing dispatch API: ${token}`);
  for (const constraint of [/\bMUST\b/, /\bunique\b/, /\bnon-empty\b/, /\beach item\b/]) {
    assert.match(requirement, constraint, "each dispatch item requires a unique, non-empty key");
  }
}

test("batch dispatch keys and collectable fan-out have one canonical owner", async () => {
  for (const id of ["GATE-EXEC-FANOUT-DISPATCH-KEY", "GATE-EXEC-COLLECTABLE-DISPATCH"]) {
    assertRuleOwned(id, "skills/docs/gate-review-sub-loop-contract.md");
  }
  assertDispatchKeyRequirement(await readRepo("skills/docs/gate-review-sub-loop-contract.md"));
  // Ownership is not agent compliance or Pi's runs.all validation. Existing
  // gate-fanin/evidence tests exercise mode refusal; dispatch-key and
  // stop-on-failure instructions also require semantic review.
});

// Synthetic owner documents: variants are built from the located requirement's protected tokens, so the
// checks never depend on the contract's surrounding wording or line breaks.
const ownerDoc = (requirement, trailer = "") => `## Owner\n\n<!-- rule: GATE-EXEC-FANOUT-DISPATCH-KEY -->\n${requirement}.\n${trailer}`;

test("dispatch-key requirement accepts reflow but cannot borrow a sibling's payload", async () => {
  const real = dispatchKeyRequirement(await readRepo("skills/docs/gate-review-sub-loop-contract.md"));
  // Reworded positives: reflowed, and reordered around the same protected tokens.
  assertDispatchKeyRequirement(ownerDoc(real.replace(/ /g, "\n")));
  assertDispatchKeyRequirement(ownerDoc("A batch reviewer dispatch through `runs.all` MUST carry on each item a unique,\nnon-empty `key`"));
  // Broken negatives: each protected token replaced in turn.
  const sibling = "\n## Sibling\nEvery `runs.all` dispatch MUST carry a unique non-empty `key` on each item.\n";
  for (const [token, replacement] of [
    ["non-empty", "optional"],
    ["unique", "repeated"],
    ["each item", "the batch"],
    ["MUST", "MAY"],
    ["`key`", "`dispatchId`"],
    ["`key`", "field"],
  ]) {
    assert.ok(real.includes(token), `real requirement carries ${token}`);
    assert.throws(() => assertDispatchKeyRequirement(ownerDoc(real.replace(token, replacement))), token);
  }
  // A sibling section's payload cannot satisfy the owner rule's own requirement.
  assert.throws(() => assertDispatchKeyRequirement(ownerDoc(real.replace("non-empty", "optional"), sibling)));
});

test("a dispatch failure cannot qualify an inline verdict outside the light carve-out", () => {
  const gate = { name: "draft_gate", executionMode: "inline_single_agent", inlineReason: "dispatch failed", scopeUnderThreshold: true };
  const policy = { lightMode: true, hasFullLabel: false };
  assert.equal(evaluateInlineFanoutMode(gate, policy), null);
  for (const [review, enforcement] of [
    [gate, { ...policy, lightMode: false }],
    [gate, { ...policy, hasFullLabel: true }],
    [{ ...gate, scopeUnderThreshold: false }, policy],
    [{ ...gate, inlineReason: "" }, policy],
  ]) assert.ok(evaluateInlineFanoutMode(review, enforcement));
  assert.equal(evaluateInlineFanoutMode({ name: "draft_gate", executionMode: "fanout_fanin" }, policy), null);
});
