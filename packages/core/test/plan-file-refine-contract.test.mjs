import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  refinePlanFileInPlace,
  PLAN_FILE_REFINE_STOP,
  DOCS_GRILL_FINDINGS_HEADING,
  COVERAGE_MATRIX_HEADING,
} from "../src/loop/plan-file-refine-contract.mjs";
import { PLAN_FILE_INTAKE_STATE } from "../src/loop/plan-file-intake-contract.mjs";

const BASE_PLAN = [
  "# Plan",
  "",
  "## Status",
  "Draft.",
  "",
  "## Objective",
  "Do the thing.",
  "",
  "## In scope",
  "The thing.",
  "",
  "## Explicit non-goals",
  "Not the other thing.",
  "",
].join("\n");

const PAYLOAD = {
  acceptanceCriteria: "- The thing works.",
  definitionOfDone: "- Tests pass; CHANGELOG updated.",
  coverageMatrix: "| Item | Type | Status | Evidence | Notes |\n|---|---|---|---|---|\n| The thing works | AC | Met | test | |",
  grillFindings: [
    { kind: "drift", docOnly: false, summary: "claim X contradicts contract Y" },
    { kind: "cosmetic", summary: "typo in heading" },
  ],
};

function newPlanFacts(markdownText) {
  return {
    markdownText,
    baseSectionsValid: true,
    hasAcceptanceCriteria: false,
    hasDefinitionOfDone: false,
  };
}

describe("refinePlanFileInPlace", () => {
  test("from new_plan_needs_refinement: writes AC/DoD/matrix/grill in place, advances, stops local", () => {
    const result = refinePlanFileInPlace({ ...newPlanFacts(BASE_PLAN), payload: PAYLOAD });
    assert.equal(result.ok, true);
    assert.equal(result.planFileIntakeState, PLAN_FILE_INTAKE_STATE.PLAN_REFINED_READY_FOR_PROMOTION);
    assert.deepEqual(result.stop, { kind: PLAN_FILE_REFINE_STOP.LOCAL_HUMAN_REVIEW });
    // Refined plan carries every refinement section in place.
    assert.match(result.refinedMarkdown, /^## Acceptance criteria$/mu);
    assert.match(result.refinedMarkdown, /^## Definition of done$/mu);
    assert.match(result.refinedMarkdown, new RegExp(`^## ${COVERAGE_MATRIX_HEADING}$`, "mu"));
    assert.match(result.refinedMarkdown, new RegExp(`^## ${DOCS_GRILL_FINDINGS_HEADING}$`, "mu"));
    // Base sections survive untouched.
    assert.match(result.refinedMarkdown, /^## Status$/mu);
    assert.match(result.refinedMarkdown, /^## Objective$/mu);
  });

  test("docs-grill runs as a step: findings classified via #948 and recorded", () => {
    const result = refinePlanFileInPlace({ ...newPlanFacts(BASE_PLAN), payload: PAYLOAD });
    assert.equal(result.ok, true);
    // drift (real) -> record_finding; cosmetic -> ignore_cosmetic.
    assert.deepEqual(
      result.grillDispositions.map((g) => g.disposition),
      ["record_finding", "ignore_cosmetic"],
    );
    assert.match(result.refinedMarkdown, /\[record_finding\] \(drift\) claim X contradicts contract Y/u);
    assert.match(result.refinedMarkdown, /\[ignore_cosmetic\] \(cosmetic\) typo in heading/u);
  });

  test("no grill findings still records an explicit none-recorded line", () => {
    const result = refinePlanFileInPlace({
      ...newPlanFacts(BASE_PLAN),
      payload: { ...PAYLOAD, grillFindings: [] },
    });
    assert.equal(result.ok, true);
    assert.match(result.refinedMarkdown, /None recorded; the docs-grill step ran/u);
  });

  test("idempotent on re-run: second refine of the written plan reproduces the same text", () => {
    const first = refinePlanFileInPlace({ ...newPlanFacts(BASE_PLAN), payload: PAYLOAD });
    assert.equal(first.ok, true);
    // The written plan now carries AC + DoD, so it classifies as already-refined.
    // Re-feeding it as new (facts say not-yet-refined) replaces in place rather
    // than duplicating: the section count stays at one each.
    const second = refinePlanFileInPlace({
      markdownText: first.refinedMarkdown,
      baseSectionsValid: true,
      hasAcceptanceCriteria: false,
      hasDefinitionOfDone: false,
      payload: PAYLOAD,
    });
    assert.equal(second.ok, true);
    const count = (text, heading) => (text.match(new RegExp(`^## ${heading}$`, "gmu")) ?? []).length;
    assert.equal(count(second.refinedMarkdown, "Acceptance criteria"), 1);
    assert.equal(count(second.refinedMarkdown, "Definition of done"), 1);
    assert.equal(count(second.refinedMarkdown, COVERAGE_MATRIX_HEADING), 1);
    assert.equal(count(second.refinedMarkdown, DOCS_GRILL_FINDINGS_HEADING), 1);
    assert.equal(second.refinedMarkdown, first.refinedMarkdown);
  });

  // ---- fail-closed cases ----

  test("fail closed: already-refined plan (not in needs_refinement) does not write or advance", () => {
    const result = refinePlanFileInPlace({
      markdownText: BASE_PLAN,
      baseSectionsValid: true,
      hasAcceptanceCriteria: true,
      hasDefinitionOfDone: true,
      payload: PAYLOAD,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_in_new_plan_needs_refinement");
    assert.equal(result.planFileIntakeState, PLAN_FILE_INTAKE_STATE.PLAN_REFINED_READY_FOR_PROMOTION);
    assert.equal(result.refinedMarkdown, undefined);
  });

  test("fail closed: ambiguous (base invalid) state does not write or advance", () => {
    const result = refinePlanFileInPlace({
      markdownText: BASE_PLAN,
      baseSectionsValid: false,
      hasAcceptanceCriteria: false,
      hasDefinitionOfDone: false,
      payload: PAYLOAD,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_in_new_plan_needs_refinement");
    assert.equal(result.planFileIntakeState, PLAN_FILE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED);
  });

  test("fail closed: missing AC/DoD/matrix payload pieces", () => {
    for (const [missing, reason] of [
      ["acceptanceCriteria", "missing_acceptance_criteria"],
      ["definitionOfDone", "missing_definition_of_done"],
      ["coverageMatrix", "missing_coverage_matrix"],
    ]) {
      const payload = { ...PAYLOAD, [missing]: "" };
      const result = refinePlanFileInPlace({ ...newPlanFacts(BASE_PLAN), payload });
      assert.equal(result.ok, false, `expected fail for missing ${missing}`);
      assert.equal(result.reason, reason);
      assert.equal(result.refinedMarkdown, undefined);
    }
  });

  test("fail closed: malformed docs-grill finding fails the grill", () => {
    const result = refinePlanFileInPlace({
      ...newPlanFacts(BASE_PLAN),
      payload: { ...PAYLOAD, grillFindings: [{ kind: "not-a-real-kind" }] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "docs_grill_failed");
    assert.equal(result.refinedMarkdown, undefined);
  });

  test("fail closed: empty markdown", () => {
    const result = refinePlanFileInPlace({ markdownText: "", baseSectionsValid: true, payload: PAYLOAD });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_plan_markdown");
  });
});
