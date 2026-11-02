/**
 * The single statement of the review-round cap shape (GATE-EXEC-ROUND-CAP, ADR 0208).
 * Pure and dependency-free. `draft_gate` uses it today; Copilot rounds import it later.
 *
 * Rounds 1..cap run, including the cap round (count equal to the cap). A clean round stops early.
 * The fixer runs on cap-round findings. Round cap+1 is refused. After the cap-round fix the next
 * action is the pre_approval path (`mark_ready_for_review`, then `pre_approval_gate`).
 * A cap of 0 (or less) disables the cap.
 */

/** The next action after the cap round's fixer pass landed: ready for review, then `pre_approval_gate`. */
export const CAP_ROUND_FIXED_NEXT_ACTION = "mark_ready_for_review";

/** Round `round` is the cap round. */
export const isCapRound = (round, cap) => cap > 0 && round === cap;

/** Round `round` is beyond the cap (round N+1) and never runs. */
export const isRoundRefused = (round, cap) => cap > 0 && round > cap;

/**
 * Shape of one round's outcome.
 * @returns {{allowed: boolean, stopsEarly: boolean, fixerRuns: boolean, nextAfterFix: string|null}}
 */
export function capRoundShape({ round, cap, clean, hasFindings }) {
  if (isRoundRefused(round, cap)) return { allowed: false, stopsEarly: false, fixerRuns: false, nextAfterFix: null };
  return {
    allowed: true,
    stopsEarly: clean === true,
    fixerRuns: clean !== true && hasFindings === true,
    nextAfterFix: isCapRound(round, cap) ? CAP_ROUND_FIXED_NEXT_ACTION : null,
  };
}
