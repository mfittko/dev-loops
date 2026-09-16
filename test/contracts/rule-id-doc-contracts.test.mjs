import assert from "node:assert/strict";
import { test } from "bun:test";

import { assertOrder, hasClauseWith } from "../imported-assets-helpers.mjs";
import { assertNotRestated, assertRuleOwned, assertRulePresent, extractOwnedText } from "./_rule-helpers.mjs";

test("stop-conditions rules are owned by rule ID, not phrase pins", () => {
  for (const id of [
    "STOP-BLOCKED-001",
    "STOP-DONE-001",
    "STOP-APPROVAL-001",
    "STOP-MERGE-AUTH-001",
    "STOP-HUMAN-MERGE-001",
    "STOP-RECONCILE-001",
    "STOP-STARTUP-INPUTS-001",
    "STOP-WAIT-001",
    "STOP-INITIAL-COPILOT-001",
    "STOP-COPILOT-REVIEW-001",
    "STOP-QUIET-WATCHER-001",
  ]) {
    assertRulePresent(id);
    assertRuleOwned(id, "skills/docs/stop-conditions.md");
  }
  assertNotRestated("STOP-COPILOT-REVIEW-001", [
    "skills/docs/public-dev-loop-contract.md",
    "skills/copilot-pr-followup/SKILL.md",
  ]);
});

test("extractOwnedText falls back to the next line when the marker sits alone", () => {
  const content = "<!-- rule: TEST-RULE-001 -->\nThe agent MUST stop before merge and report the reconcile gate.";
  assert.equal(
    extractOwnedText(content, "TEST-RULE-001"),
    "The agent MUST stop before merge and report the reconcile gate.",
  );
});

// --- Prose-structure helper discrimination ----------------------------------
// The doc contracts replaced word-for-word sentence pins with these two
// structural primitives. Their value depends entirely on discriminating between
// "reworded" and "obligation removed", so that property is tested directly
// rather than assumed from the call sites that use them.

test("hasClauseWith accepts a meaning-preserving rewrite of the same statement", () => {
  const original = "Do NOT bound this step by `artifact.fanout.wavePlan`: that plan counts unsplit units.";
  const reworded = "This step is never bounded by `artifact.fanout.wavePlan`,\nwhich counts unsplit units.";
  for (const text of [original, reworded]) {
    assert.ok(hasClauseWith(text, /wavePlan/, /\b(?:not|never)\b/i), `expected a structural match in: ${text}`);
  }
});

test("hasClauseWith rejects text that drops the obligation but keeps the tokens", () => {
  const violating = "Bound this step by `artifact.fanout.wavePlan`. Reviewers should not be dispatched twice.";
  assert.equal(hasClauseWith(violating, /wavePlan/, /\b(?:not|never)\b/i), false);
});

test("hasClauseWith does not join two unrelated sentences into one match", () => {
  const split = "The wave plan is recorded as `artifact.fanout.wavePlan`. Reviewers are never re-dispatched.";
  assert.equal(hasClauseWith(split, /wavePlan/, /\bnever\b/i), false);
});

test("hasClauseWith does not join two unpunctuated markdown bullets into one match", () => {
  // Bullets routinely carry no terminal punctuation. Splitting on sentence
  // terminators alone would merge a whole list into one pseudo-sentence and let
  // tokens from unrelated bullets satisfy a co-occurrence check.
  const bullets = [
    "- the wave bound is `artifact.fanout.wavePlan`",
    "- a carried angle is never re-dispatched",
  ].join("\n");
  assert.equal(hasClauseWith(bullets, /wavePlan/, /\bnever\b/i), false);
  const oneBullet = "- the wave bound is never `artifact.fanout.wavePlan`";
  assert.ok(hasClauseWith(oneBullet, /wavePlan/, /\bnever\b/i));
});

test("hasClauseWith does not join two table rows into one match", () => {
  const rows = [
    "| `artifact.fanout.wavePlan` | the wave count |",
    "| `maxConcurrent` | never exceeded |",
  ].join("\n");
  assert.equal(hasClauseWith(rows, /wavePlan/, /\bnever\b/i), false);
});

test("both helpers reject a stateful global marker instead of silently passing", () => {
  // A /g marker makes String.match drop .index (NaN cursor, order enforcement
  // silently off) and RegExp.test stateful across calls. Both must fail loudly.
  assert.throws(() => hasClauseWith("the wave plan is never rebuilt", /wave/g, /never/), /must not carry the g or y flag/);
  assert.throws(() => assertOrder("first second", [/first/g, /second/], "fixture"), /must not carry the g or y flag/);
  assert.throws(() => assertOrder("first second", [/first/y, /second/], "fixture"), /must not carry the g or y flag/);
});

test("assertOrder tolerates a marker spanning a line wrap in raw document text", () => {
  const wrapped = "First refresh the\norigin/main ref. Then obtain\nauthorization.";
  assertOrder(wrapped, [/origin\/main ref/, /obtain authorization/], "wrapped fixture");
});

test("assertOrder accepts a reworded procedure and rejects a reordered one", () => {
  const reworded = "First refresh origin/main. Then obtain authorization. Only then reconcile locally.";
  assertOrder(reworded, [/origin\/main/, /authoriz/i, /reconcile/i], "reworded fixture");
  const reordered = "Reconcile locally first. Afterwards ask for authorization.";
  assert.throws(() => assertOrder(reordered, [/authoriz/i, /reconcile/i], "reordered fixture"));
});
