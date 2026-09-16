import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  CURRENT_TO_LEGACY_LOOP_VOCABULARY,
  LEGACY_LOOP_VOCABULARY,
  isSameLoopConcept,
  normalizeLoopVocabularyToken,
  toLegacyLoopVocabularyToken,
} from "../src/loop/loop-vocabulary.mjs";

test("every legacy lane token maps to its verification-lane counterpart (ADR 0073)", () => {
  assert.deepEqual(LEGACY_LOOP_VOCABULARY, {
    copilot_pr_followup: "verification",
    copilot_loop: "verification_loop",
    handoff_to_copilot_loop: "handoff_to_verification_loop",
    reenter_copilot_loop: "enter_verification_loop",
    reenter_reviewer_loop: "enter_reviewer_loop",
    waiting_for_copilot_review: "waiting_for_external_review",
  });
  for (const [legacy, current] of Object.entries(LEGACY_LOOP_VOCABULARY)) {
    assert.equal(normalizeLoopVocabularyToken(legacy), current);
    assert.equal(toLegacyLoopVocabularyToken(current), legacy);
    assert.equal(CURRENT_TO_LEGACY_LOOP_VOCABULARY[current], legacy);
  }
});

test("a token the table does not know passes through unchanged, never coerced", () => {
  // The fail-open that matters: a checkpoint from a newer or forked producer is
  // data, not an error, and must not be rewritten into a token we do know.
  for (const token of ["some_future_state", "copilotish", "", "handoff_to_reviewer_loop"]) {
    assert.equal(normalizeLoopVocabularyToken(token), token);
    assert.equal(toLegacyLoopVocabularyToken(token), token);
  }
});

test("non-string input is returned as-is rather than stringified", () => {
  for (const value of [null, undefined, 42, { state: "copilot_loop" }]) {
    assert.equal(normalizeLoopVocabularyToken(value), value);
    assert.equal(toLegacyLoopVocabularyToken(value), value);
  }
});

test("the round trip is stable in both directions", () => {
  for (const [legacy, current] of Object.entries(LEGACY_LOOP_VOCABULARY)) {
    assert.equal(normalizeLoopVocabularyToken(normalizeLoopVocabularyToken(legacy)), current);
    assert.equal(toLegacyLoopVocabularyToken(toLegacyLoopVocabularyToken(current)), legacy);
  }
});

test("isSameLoopConcept matches across vocabularies and never across concepts", () => {
  assert.equal(isSameLoopConcept("copilot_loop", "verification_loop"), true);
  assert.equal(isSameLoopConcept("handoff_to_copilot_loop", "handoff_to_verification_loop"), true);
  assert.equal(isSameLoopConcept("waiting_for_external_review", "waiting_for_external_review"), true);

  assert.equal(isSameLoopConcept("handoff_to_copilot_loop", "handoff_to_reviewer_loop"), false);
  assert.equal(isSameLoopConcept("copilot_loop", "outer_loop"), false);
  // The human reviewer lane is a different concept and must not be absorbed.
  assert.equal(isSameLoopConcept("waiting_for_copilot_review", "waiting_for_review_request"), false);
});

test("tokens that stay Copilot-named on purpose are absent from the table", () => {
  // The review-actor adapter, the round metrics and Copilot-as-author ownership
  // are genuinely vendor-specific (ADR 0073), so mapping them would be a lie.
  for (const token of [
    "copilotReviewRounds",
    "copilotReviewComments",
    "assigned_to_copilot",
    "copilot_session_active",
  ]) {
    assert.equal(Object.hasOwn(LEGACY_LOOP_VOCABULARY, token), false, `${token} must not be renamed`);
    assert.equal(normalizeLoopVocabularyToken(token), token);
  }
});
