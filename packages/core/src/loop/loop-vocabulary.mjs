/**
 * loop-vocabulary.mjs — the one place the legacy Copilot-named loop vocabulary
 * maps to the actor-neutral external-review vocabulary (ADR 0073).
 *
 * The lane is named for the lane: its actor is EXTERNAL to the loop and
 * ASYNCHRONOUS (the loop requests a review and durably waits on GitHub events),
 * which is what distinguishes it from our own gate review, our internal fan-out
 * reviewer units, the human reviewer lane, and the pre-approval evidence gate.
 *
 * Tokens that stay Copilot-named on purpose are NOT in this table: the review
 * actor adapter (`isCopilotLogin`, request/probe/withdraw), the round metrics
 * (every input is filtered by `isCopilotLogin`, so they really do count
 * Copilot's rounds), and Copilot-as-author ownership/session detection.
 */

/** Legacy token -> current token. Lane vocabulary only (ADR 0073). */
export const LEGACY_LOOP_VOCABULARY = Object.freeze({
  copilot_pr_followup: "verification",
  copilot_loop: "verification_loop",
  handoff_to_copilot_loop: "handoff_to_verification_loop",
  // `reenter_` claimed a re-entry on a FIRST handoff with zero completed rounds.
  // `enter_` is true on the first entry and still true on a later one, so both
  // lanes drop the prefix together rather than leaving one half-corrected.
  reenter_copilot_loop: "enter_verification_loop",
  reenter_reviewer_loop: "enter_reviewer_loop",
  waiting_for_copilot_review: "waiting_for_external_review",
});

/** Current token -> legacy token, for emitting to a reader pinned to the old vocabulary. */
export const CURRENT_TO_LEGACY_LOOP_VOCABULARY = Object.freeze(
  Object.fromEntries(Object.entries(LEGACY_LOOP_VOCABULARY).map(([legacy, current]) => [current, legacy])),
);

/**
 * Map a persisted loop token to the current vocabulary.
 *
 * TOTAL by design: anything this table does not know passes through unchanged.
 * A checkpoint written by a newer or a forked producer must never be coerced
 * into a token this map happens to contain — an unknown token is data, not an
 * error, and silently rewriting it would be exactly the drift this seam exists
 * to prevent.
 *
 * @param {unknown} token
 * @returns {unknown} the current token, or the input unchanged
 */
export function normalizeLoopVocabularyToken(token) {
  if (typeof token !== "string") {
    return token;
  }
  return LEGACY_LOOP_VOCABULARY[token] ?? token;
}

/**
 * True when `token` names the same loop concept as `expected`, in either
 * vocabulary. Use at read boundaries that compare a persisted token against a
 * constant, so a checkpoint written before the rename still matches.
 *
 * @param {unknown} token
 * @param {unknown} expected
 */
export function isSameLoopConcept(token, expected) {
  return normalizeLoopVocabularyToken(token) === normalizeLoopVocabularyToken(expected);
}

/**
 * Map a current token back to its legacy spelling, for a writer that must stay
 * readable by a consumer pinned to the previous release. Unknown tokens pass
 * through unchanged, same contract as the forward direction.
 *
 * @param {unknown} token
 */
export function toLegacyLoopVocabularyToken(token) {
  if (typeof token !== "string") {
    return token;
  }
  return CURRENT_TO_LEGACY_LOOP_VOCABULARY[token] ?? token;
}
