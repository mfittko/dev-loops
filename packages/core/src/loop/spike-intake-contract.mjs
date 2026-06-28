/**
 * Spike-mode intake state machine.
 *
 * A `--spike` startup hands the dev-loop a time-boxed, exploratory artifact that
 * lives outside the tracker — startable from a local question with no GitHub
 * issue. A spike is NOT a plan-needing-refinement, so its states are distinct
 * from PLAN_FILE_INTAKE_STATE: it classifies how far the exploration has
 * progressed toward an exit decision, not how far a plan has progressed toward
 * promotion.
 *
 * This evaluator mirrors `evaluatePlanFileIntakeState`: a frozen enum plus a
 * pure, deterministic function with no GitHub or filesystem side effects — the
 * caller supplies the section-presence facts it has already read.
 *
 * The two non-ambiguous states are the seam phase 2 (#965) consumes for its
 * discard/graduate exits:
 *   - SPIKE_IN_PROGRESS    — exploration ongoing (no recommendation yet); a
 *                            discard exit can drop it with no artifact.
 *   - SPIKE_READY_FOR_EXIT — a recommendation has been reached; phase 2 routes
 *                            this to graduate (promote into a plan/PR) or
 *                            discard (recommendation is "don't pursue").
 */

export const SPIKE_INTAKE_STATE = Object.freeze({
  /** Valid spike artifact; the Recommendation is not yet reached. */
  SPIKE_IN_PROGRESS: "spike_in_progress",
  /** Valid spike artifact carrying a Recommendation; an exit decision can be made. */
  SPIKE_READY_FOR_EXIT: "spike_ready_for_exit",
  /** Inputs are malformed or unusable; fail closed. */
  AMBIGUOUS_FAIL_CLOSED: "ambiguous_fail_closed",
});

/**
 * Pure intake-state classifier.
 *
 * @param {object} facts
 * @param {boolean} facts.baseSectionsValid  whether the spike's exploration scaffold (Question/Approach/Findings) is present and non-empty. Recommendation is NOT part of this fact — it is the separate exit-marker carried by `hasRecommendation`, so that a scaffold-valid spike without a Recommendation classifies as in-progress rather than failing closed.
 * @param {boolean} facts.hasRecommendation  whether a non-empty Recommendation section is present (the exit-marker that flips in-progress → ready-for-exit)
 * @returns {{ state: string }} one of SPIKE_INTAKE_STATE values
 */
export function evaluateSpikeIntakeState({ baseSectionsValid, hasRecommendation } = {}) {
  // A malformed spike artifact (missing/empty base sections) is unusable intake
  // input; fail closed instead of guessing an exit.
  if (baseSectionsValid !== true) {
    return { state: SPIKE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED };
  }
  return {
    state: hasRecommendation === true
      ? SPIKE_INTAKE_STATE.SPIKE_READY_FOR_EXIT
      : SPIKE_INTAKE_STATE.SPIKE_IN_PROGRESS,
  };
}
