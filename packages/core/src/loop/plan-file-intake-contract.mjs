/**
 * Local-planning plan-file intake state machine.
 *
 * A `--plan-file` startup hands the dev-loop a phase-doc-format plan that lives
 * outside the tracker. Before promotion there is no issue to key a worktree on,
 * so this intake stage classifies how far the plan has progressed through
 * refinement. The classification drives whether the next step is refinement or
 * promotion.
 *
 * This evaluator mirrors the `DEV_LOOP_ISSUE_ASSIGNMENT_SEAM` precedent: a
 * frozen enum plus a pure, deterministic function. It performs no GitHub or
 * filesystem side effects — the caller supplies the section-presence facts it
 * has already read.
 */

export const PLAN_FILE_INTAKE_STATE = Object.freeze({
  /** Plan carries only the base authoring sections; refinement has not run. */
  NEW_PLAN_NEEDS_REFINEMENT: "new_plan_needs_refinement",
  /** Plan also carries Acceptance criteria + Definition of done; refinement already ran. */
  PLAN_REFINED_READY_FOR_PROMOTION: "plan_refined_ready_for_promotion",
  /** Inputs are ambiguous, conflicting, or unusable; fail closed. */
  AMBIGUOUS_FAIL_CLOSED: "ambiguous_fail_closed",
});

/**
 * Refinement-marker sections a plan gains once refinement has run on top of the
 * base authoring sections.
 */
export const PLAN_FILE_REFINEMENT_SECTIONS = Object.freeze(["Acceptance criteria", "Definition of done"]);

/**
 * Pure intake-state classifier.
 *
 * @param {object} facts
 * @param {boolean} facts.baseSectionsValid  whether the plan passes the base-section validator (Status/Objective/In scope/Explicit non-goals)
 * @param {boolean} facts.hasAcceptanceCriteria  whether a non-empty Acceptance criteria section is present
 * @param {boolean} facts.hasDefinitionOfDone  whether a non-empty Definition of done section is present
 * @returns {{ state: string }} one of PLAN_FILE_INTAKE_STATE values
 */
export function evaluatePlanFileIntakeState({ baseSectionsValid, hasAcceptanceCriteria, hasDefinitionOfDone } = {}) {
  // A plan that fails the base contract should already have been rejected by the
  // caller; treating it as intake input here is ambiguous, so fail closed.
  if (baseSectionsValid !== true) {
    return { state: PLAN_FILE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED };
  }
  // Refinement markers must be present as a pair. A plan carrying exactly one of
  // the two refinement sections is partially refined in an undefined way; fail
  // closed instead of guessing whether to refine or promote.
  if (hasAcceptanceCriteria === true && hasDefinitionOfDone === true) {
    return { state: PLAN_FILE_INTAKE_STATE.PLAN_REFINED_READY_FOR_PROMOTION };
  }
  if (hasAcceptanceCriteria !== true && hasDefinitionOfDone !== true) {
    return { state: PLAN_FILE_INTAKE_STATE.NEW_PLAN_NEEDS_REFINEMENT };
  }
  return { state: PLAN_FILE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED };
}
