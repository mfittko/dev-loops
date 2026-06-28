import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  evaluateSpikeIntakeState,
  SPIKE_INTAKE_STATE,
} from "../src/loop/spike-intake-contract.mjs";

describe("evaluateSpikeIntakeState (pure)", () => {
  test("valid spike artifact with no recommendation yet is spike_in_progress", () => {
    const { state } = evaluateSpikeIntakeState({
      baseSectionsValid: true,
      hasRecommendation: false,
    });
    assert.equal(state, SPIKE_INTAKE_STATE.SPIKE_IN_PROGRESS);
  });

  test("valid spike artifact carrying a recommendation is spike_ready_for_exit", () => {
    const { state } = evaluateSpikeIntakeState({
      baseSectionsValid: true,
      hasRecommendation: true,
    });
    assert.equal(state, SPIKE_INTAKE_STATE.SPIKE_READY_FOR_EXIT);
  });

  test("malformed spike artifact (base sections invalid) fails closed", () => {
    const { state } = evaluateSpikeIntakeState({
      baseSectionsValid: false,
      hasRecommendation: true,
    });
    assert.equal(state, SPIKE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED);
  });

  test("missing input fails closed", () => {
    assert.equal(evaluateSpikeIntakeState().state, SPIKE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED);
  });

  test("spike states are DISTINCT from plan-file intake states", () => {
    const values = new Set(Object.values(SPIKE_INTAKE_STATE));
    // A spike is not a plan-needing-refinement: it carries no plan-file states.
    assert.ok(!values.has("new_plan_needs_refinement"));
    assert.ok(!values.has("plan_refined_ready_for_promotion"));
    assert.ok(values.has("spike_in_progress"));
    assert.ok(values.has("spike_ready_for_exit"));
  });
});
