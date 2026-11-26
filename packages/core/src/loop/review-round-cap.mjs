/**
 * The single statement of the review-round cap shape (GATE-EXEC-ROUND-CAP, ADR 0208) and, in `decideCapRound`, of the cap brakes (GATE-EXEC-CAP-BRAKES).
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

/** A head whose wholeLogicLoc is above this multiple of the forecast wloc stops the lane (GATE-EXEC-CAP-BRAKES). */
export const GROWTH_FACTOR = 2;

/**
 * The cap brakes of draft_gate and pre_approval_gate (GATE-EXEC-CAP-BRAKES): the one policy that decides
 * whether round `round` (1-based, the round about to run) is a full round, the scoped final round, or goes to the operator.
 * `actCounts` holds the distinct acted cluster count of each closed round, oldest first. `fixBudget` is
 * `{ logicLoc, addedFiles, maxLines }` for the PR-own diff since the cap-round head. A null `forecastWloc` never trips growth.
 * @returns {{action: "full_round"|"scoped_final_round"}|{action: "operator", reason: string, numbers: object}}
 */
export function decideCapRound({ round, cap, actCounts = [], fixBudget, wholeLogicLoc, forecastWloc }) {
  const operator = (reason, numbers) => ({ action: "operator", reason, numbers });
  if (forecastWloc > 0 && wholeLogicLoc > GROWTH_FACTOR * forecastWloc) return operator("growth_past_forecast", { wholeLogicLoc, forecastWloc });
  const [previous, current] = actCounts.slice(-2);
  // A round after a clean round (previous 0) restarts the count: only a round that follows open act items can fail to shrink them.
  if (previous > 0 && current >= previous) return operator("non_convergence", { previous, current });
  if (!(cap > 0) || round <= cap) return { action: "full_round" };
  if (round > cap + 1) return operator("round_cap_reached", { round, cap });
  const { logicLoc, addedFiles, maxLines } = fixBudget;
  if (logicLoc > maxLines || addedFiles > 0) return operator("cap_fix_over_budget", { logicLoc, maxLines, addedFiles });
  return { action: "scoped_final_round" };
}

const CAP_STOP_TEXT = {
  round_cap_reached: ({ round, cap }) => `round ${round} is past the round cap of ${cap} and the scoped final round has run`,
  cap_fix_over_budget: ({ logicLoc, maxLines, addedFiles }) => `the fix since the cap-round head is ${logicLoc} logic LOC (budget ${maxLines}) and adds ${addedFiles} file(s)`,
  non_convergence: ({ previous, current }) => `the judged act count did not shrink (${previous} then ${current})`,
  growth_past_forecast: ({ wholeLogicLoc, forecastWloc }) => `wholeLogicLoc ${wholeLogicLoc} is above ${GROWTH_FACTOR} times the forecast wloc ${forecastWloc}`,
};

/** One sentence naming the numbers of an `operator` decision, for the refusal and the `report_blocked` reason. */
export const describeCapStop = ({ reason, numbers }, { clearable = true } = {}) => `${reason}: ${CAP_STOP_TEXT[reason](numbers)}${clearable ? "; the operator clears it with an operator focus item whose decision names the act items by fingerprint (GATE-EXEC-CAP-BRAKES)" : " (GATE-EXEC-CAP-BRAKES)"}`;
