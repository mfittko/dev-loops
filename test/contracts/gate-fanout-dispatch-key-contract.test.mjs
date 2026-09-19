import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { evaluateInlineFanoutMode } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { parseMarkdownSections } from "../../packages/core/src/loop/issue-refinement-artifact.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";

function assertDispatchKeyRequirement(content) {
  const marker = "<!-- rule: GATE-EXEC-FANOUT-DISPATCH-KEY -->";
  const lines = parseMarkdownSections(content).find(({ bodyLines }) => bodyLines.includes(marker))?.bodyLines;
  assert.ok(lines, "dispatch-key owner section must exist");
  const tail = lines.slice(lines.indexOf(marker) + 1);
  const boundary = tail.findIndex((line) => !line.trim() || /^<!-- rule:/.test(line));
  const requirement = tail.slice(0, boundary < 0 ? undefined : boundary).join(" ")
    .split(/\.(?=\s|$)/, 1)[0].replace(/\s+/g, " ");
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

test("dispatch-key requirement accepts reflow but cannot borrow a sibling's payload", async () => {
  const owner = await readRepo("skills/docs/gate-review-sub-loop-contract.md");
  assertDispatchKeyRequirement(owner.replace("Every `runs.all` / batch reviewer dispatch", "Every batch reviewer dispatch through `runs.all`")
    .replace("a unique\nnon-empty `key` on each item", "a unique non-empty\n`key` on each\nitem"));
  for (const changed of [
    owner.replace("non-empty `key`", "non-empty field"),
    owner.replace("non-empty `key`", "non-empty ``"),
    owner.replace("non-empty `key`", "non-empty `dispatchId`"),
    owner.replace("a unique\nnon-empty", "a repeated\nnon-empty"),
    owner.replace("non-empty `key`", "optional `key`"),
    owner.replace("`key` on each item", "`key` on the batch"),
    owner.replace("MUST carry a unique", "MAY carry a unique"),
    owner.replace("non-empty `key`", "non-empty field")
      + "\n## Sibling\nEvery `runs.all` dispatch MUST carry a unique non-empty `key` on each item.\n",
  ]) assert.throws(() => assertDispatchKeyRequirement(changed));
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
