/**
 * The single statement of the review-round cap (GATE-EXEC-ROUND-CAP, ADR 0208) and, in `decideCapRound`, of the cap brakes (GATE-EXEC-CAP-BRAKES).
 * Pure and dependency-free. `draft_gate` and `pre_approval_gate` use it; Copilot rounds use the two predicates.
 *
 * Rounds 1..cap run, including the cap round (count equal to the cap). A clean round stops early.
 * A cap of 0 (or less) disables the cap. The round after the cap round is decided by `decideCapRound`.
 */

/** Round `round` is the cap round. */
export const isCapRound = (round, cap) => cap > 0 && round === cap;

/** Round `round` is beyond the cap (round N+1). */
export const isRoundRefused = (round, cap) => cap > 0 && round > cap;

/** A head whose wholeLogicLoc is above this multiple of the forecast wloc stops the lane (GATE-EXEC-CAP-BRAKES). */
export const GROWTH_FACTOR = 2;

/**
 * The cap brakes of draft_gate and pre_approval_gate (GATE-EXEC-CAP-BRAKES): the one policy that decides
 * whether round `round` (1-based, the round about to run) is a full round, the scoped final round, or goes to the operator.
 * `fixBudget` is `{ logicLoc, addedFiles, maxLines }` for the PR-own diff since the cap-round head. A null `forecastWloc` never trips growth.
 * `bodyOnlyRerun` marks the same-head rerun of the body-reading units after a PR-body edit: it is a full round at any round count (growth still stops it).
 * @returns {{action: "full_round"|"scoped_final_round"}|{action: "operator", reason: string, numbers: object}}
 */
export function decideCapRound({ round, cap, fixBudget, wholeLogicLoc, forecastWloc, bodyOnlyRerun = false }) {
  const operator = (reason, numbers) => ({ action: "operator", reason, numbers });
  if (forecastWloc > 0 && wholeLogicLoc > GROWTH_FACTOR * forecastWloc) return operator("growth_past_forecast", { wholeLogicLoc, forecastWloc });
  // A body-only rerun (GATE-EXEC-BODY-ONLY-RERUN) re-reviews a PR-body edit at the same head: it is no cap round and has no fix to budget.
  if (!(cap > 0) || round <= cap || bodyOnlyRerun) return { action: "full_round" };
  if (round > cap + 1) return operator("round_cap_reached", { round, cap });
  const { logicLoc, addedFiles, maxLines } = fixBudget;
  if (logicLoc > maxLines || addedFiles > 0) return operator("cap_fix_over_budget", { logicLoc, maxLines, addedFiles });
  return { action: "scoped_final_round" };
}

const CAP_STOP_TEXT = {
  round_cap_reached: ({ round, cap }) => `round ${round} is past the round cap of ${cap} and the scoped final round has run`,
  cap_fix_over_budget: ({ logicLoc, maxLines, addedFiles }) => `the fix since the cap-round head is ${logicLoc} logic LOC (budget ${maxLines}) and adds ${addedFiles} file(s)`,
  growth_past_forecast: ({ wholeLogicLoc, forecastWloc }) => `wholeLogicLoc ${wholeLogicLoc} is above ${GROWTH_FACTOR} times the forecast wloc ${forecastWloc}`,
};

/** One sentence naming the numbers of an `operator` decision, for the refusal and the `report_blocked` reason. */
export const describeCapStop = ({ reason, numbers }, { clearable = true } = {}) => `${reason}: ${CAP_STOP_TEXT[reason](numbers)}${clearable ?"; the operator clears it with an operator focus item whose decision names the act items by fingerprint (GATE-EXEC-CAP-BRAKES)" : " (GATE-EXEC-CAP-BRAKES)"}`;
