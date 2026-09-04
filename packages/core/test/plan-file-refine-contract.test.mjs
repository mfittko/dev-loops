import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  refinePlanFileInPlace,
  validatePhaseSizeEstimate,
  PLAN_FILE_REFINE_STOP,
  DOCS_GRILL_FINDINGS_HEADING,
  COVERAGE_MATRIX_HEADING,
  SIZE_ESTIMATE_HEADING,
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
  sizeEstimate: { logicLoc: 90, tier: "default" },
  grillDispositions: [
    { kind: "drift", summary: "claim X contradicts contract Y", disposition: "record_finding" },
    { kind: "cosmetic", summary: "typo in heading", disposition: "ignore_cosmetic" },
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
    assert.match(result.refinedMarkdown, new RegExp(`^## ${SIZE_ESTIMATE_HEADING}$`, "mu"));
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
      payload: { ...PAYLOAD, grillDispositions: [] },
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

  test("fail closed: missing size estimate", () => {
    const payload = { ...PAYLOAD, sizeEstimate: undefined };
    const result = refinePlanFileInPlace({ ...newPlanFacts(BASE_PLAN), payload });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_size_estimate");
    assert.equal(result.refinedMarkdown, undefined);
  });

  test("fail closed: an over-softLoc size estimate with no oversizeJustification (prompts a seam search)", () => {
    const payload = { ...PAYLOAD, sizeEstimate: { logicLoc: 900, tier: "default" } };
    const result = refinePlanFileInPlace({ ...newPlanFacts(BASE_PLAN), payload, sizeSoftLoc: 400 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "size_estimate_oversize_not_justified");
    assert.equal(result.refinedMarkdown, undefined);
  });

  test("a cohesive over-softLoc size estimate with oversizeJustification proceeds and records the note", () => {
    const payload = {
      ...PAYLOAD,
      sizeEstimate: { logicLoc: 900, tier: "default", oversizeJustification: "one cohesive migration; no clean seam to split on" },
    };
    const result = refinePlanFileInPlace({ ...newPlanFacts(BASE_PLAN), payload, sizeSoftLoc: 400 });
    assert.equal(result.ok, true);
    assert.equal(result.sizeEstimate.overBudget, true);
    assert.equal(result.sizeEstimate.oversizeNote, "one cohesive migration; no clean seam to split on");
    assert.match(result.refinedMarkdown, /- Estimated logic LOC: 900/u);
    assert.match(result.refinedMarkdown, /- Oversize: justified — one cohesive migration; no clean seam to split on/u);
  });

  test("an under-softLoc size estimate needs no justification and records n\\/a", () => {
    const result = refinePlanFileInPlace({ ...newPlanFacts(BASE_PLAN), payload: PAYLOAD, sizeSoftLoc: 400 });
    assert.equal(result.ok, true);
    assert.equal(result.sizeEstimate.overBudget, false);
    assert.equal(result.sizeEstimate.oversizeNote, null);
    assert.match(result.refinedMarkdown, /- Oversize: n\/a \(within default tier's softLoc budget of 400\)/u);
  });

  test("fail closed: a grill disposition that is missing/invalid fails the grill", () => {
    // The CLI classifies findings and passes dispositions in; an unclassifiable
    // finding arrives with a null disposition, which must fail the grill closed.
    const result = refinePlanFileInPlace({
      ...newPlanFacts(BASE_PLAN),
      payload: { ...PAYLOAD, grillDispositions: [{ kind: "x", summary: "", disposition: null }] },
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

  test("fail closed: a section body containing a top-level heading", () => {
    // An embedded `## ` in a managed section body would break the strip-then-append
    // idempotency (stripSection scans to the next `## `), so it must fail closed.
    const result = refinePlanFileInPlace({
      ...newPlanFacts(BASE_PLAN),
      payload: { ...PAYLOAD, acceptanceCriteria: "- ok\n## Sneaky inner heading\nmore" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "section_body_contains_heading");
    assert.equal(result.refinedMarkdown, undefined);
  });

  test("fail closed: a top-level heading smuggled into the oversize justification", () => {
    const result = refinePlanFileInPlace({
      ...newPlanFacts(BASE_PLAN),
      payload: {
        ...PAYLOAD,
        sizeEstimate: { logicLoc: 900, tier: "default", oversizeJustification: "ok\n## Sneaky inner heading\nmore" },
      },
      sizeSoftLoc: 400,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "section_body_contains_heading");
    assert.equal(result.refinedMarkdown, undefined);
  });
});

describe("validatePhaseSizeEstimate (pure)", () => {
  test("under-threshold estimate needs no justification", () => {
    const result = validatePhaseSizeEstimate({ logicLoc: 100, tier: "default" }, 400);
    assert.equal(result.ok, true);
    assert.equal(result.overBudget, false);
    assert.equal(result.oversizeNote, null);
  });

  test("tier defaults to \"default\" when omitted", () => {
    const result = validatePhaseSizeEstimate({ logicLoc: 100 }, 400);
    assert.equal(result.ok, true);
    assert.equal(result.tier, "default");
  });

  test("over-threshold estimate without justification fails closed", () => {
    const result = validatePhaseSizeEstimate({ logicLoc: 500, tier: "default" }, 400);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "size_estimate_oversize_not_justified");
  });

  test("over-threshold estimate with a blank justification still fails closed", () => {
    const result = validatePhaseSizeEstimate({ logicLoc: 500, oversizeJustification: "   " }, 400);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "size_estimate_oversize_not_justified");
  });

  test("over-threshold estimate with a justification passes and carries the note", () => {
    const result = validatePhaseSizeEstimate({ logicLoc: 500, oversizeJustification: "cohesive, no seam" }, 400);
    assert.equal(result.ok, true);
    assert.equal(result.overBudget, true);
    assert.equal(result.oversizeNote, "cohesive, no seam");
    assert.match(result.body, /Oversize: justified — cohesive, no seam/u);
  });

  test("missing estimate fails closed", () => {
    assert.equal(validatePhaseSizeEstimate(undefined).ok, false);
    assert.equal(validatePhaseSizeEstimate(undefined).reason, "missing_size_estimate");
    assert.equal(validatePhaseSizeEstimate(null).reason, "missing_size_estimate");
  });

  test("non-integer or negative logicLoc fails closed", () => {
    assert.equal(validatePhaseSizeEstimate({ logicLoc: 1.5 }).reason, "invalid_size_estimate_loc");
    assert.equal(validatePhaseSizeEstimate({ logicLoc: -1 }).reason, "invalid_size_estimate_loc");
    assert.equal(validatePhaseSizeEstimate({ logicLoc: "100" }).reason, "invalid_size_estimate_loc");
  });

  test("an unrecognized tier fails closed", () => {
    const result = validatePhaseSizeEstimate({ logicLoc: 100, tier: "t2" }, 400);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_size_estimate_tier");
  });

  test("falls back to the default softLoc when no threshold is passed", () => {
    // 400 is check-size-budget.mjs's own DEFAULT_TIER_DEFAULTS.softLoc — same vocabulary/threshold.
    assert.equal(validatePhaseSizeEstimate({ logicLoc: 400 }).overBudget, false);
    assert.equal(validatePhaseSizeEstimate({ logicLoc: 401 }, undefined).ok, false);
  });
});
