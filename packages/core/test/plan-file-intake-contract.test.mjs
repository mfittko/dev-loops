import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  evaluatePlanFileIntakeState,
  PLAN_FILE_INTAKE_STATE,
  PLAN_FILE_REFINEMENT_SECTIONS,
} from "../src/loop/plan-file-intake-contract.mjs";

describe("evaluatePlanFileIntakeState (pure)", () => {
  test("base sections only classifies as new_plan_needs_refinement", () => {
    const { state } = evaluatePlanFileIntakeState({
      baseSectionsValid: true,
      hasAcceptanceCriteria: false,
      hasDefinitionOfDone: false,
    });
    assert.equal(state, PLAN_FILE_INTAKE_STATE.NEW_PLAN_NEEDS_REFINEMENT);
  });

  test("base + AC + DoD classifies as plan_refined_ready_for_promotion", () => {
    const { state } = evaluatePlanFileIntakeState({
      baseSectionsValid: true,
      hasAcceptanceCriteria: true,
      hasDefinitionOfDone: true,
    });
    assert.equal(state, PLAN_FILE_INTAKE_STATE.PLAN_REFINED_READY_FOR_PROMOTION);
  });

  test("only one refinement section present fails closed (ambiguous)", () => {
    const acOnly = evaluatePlanFileIntakeState({
      baseSectionsValid: true,
      hasAcceptanceCriteria: true,
      hasDefinitionOfDone: false,
    });
    assert.equal(acOnly.state, PLAN_FILE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED);
    const dodOnly = evaluatePlanFileIntakeState({
      baseSectionsValid: true,
      hasAcceptanceCriteria: false,
      hasDefinitionOfDone: true,
    });
    assert.equal(dodOnly.state, PLAN_FILE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED);
  });

  test("invalid base sections fails closed regardless of refinement markers", () => {
    const { state } = evaluatePlanFileIntakeState({
      baseSectionsValid: false,
      hasAcceptanceCriteria: true,
      hasDefinitionOfDone: true,
    });
    assert.equal(state, PLAN_FILE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED);
  });

  test("missing input fails closed", () => {
    assert.equal(evaluatePlanFileIntakeState().state, PLAN_FILE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED);
  });

  test("refinement section headings are the AC + DoD pair", () => {
    assert.deepEqual(PLAN_FILE_REFINEMENT_SECTIONS, ["Acceptance criteria", "Definition of done"]);
  });
});
