import assert from "node:assert/strict";
import test from "node:test";

import { validatePrBodySpec, validateTrackerBackedPrBodySpec } from "../src/loop/issue-refinement-artifact.mjs";

// ---------------------------------------------------------------------------
// Tracker-backed PR-description contract enforcement (issue #1863)
//
// The lightweight/issue-less path (pr-body-spec-lightweight.test.mjs) already
// pins validatePrBodySpec's full invariant set. These tests pin the SEPARATE
// contract skills/docs/copilot-loop-operations.md's "PR description contract"
// requires of a TRACKER-BACKED PR's own body: Acceptance criteria + Definition
// of done checklists, an explicit Non-goals section, and a Closes #N/Fixes #N
// reference — via the reused validatePrBodySpec (requireOpenQuestions:false),
// not a second divergent checker.
// ---------------------------------------------------------------------------

const COMPLIANT_BODY = `Closes #900

## Objective
Ship the feature.

## In scope
- the feature

## Explicit non-goals
- unrelated cleanup

## Acceptance criteria
- [ ] the feature works

## Definition of done
- [ ] npm run verify is green
`;

test("validateTrackerBackedPrBodySpec: a fully compliant tracker-backed body passes (green path)", () => {
  const result = validateTrackerBackedPrBodySpec({ body: COMPLIANT_BODY, closingIssues: [900] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.acItems, ["the feature works"]);
  assert.deepEqual(result.dodItems, ["npm run verify is green"]);
  assert.deepEqual(result.closesIssues, [900]);
});

test("validateTrackerBackedPrBodySpec: does NOT require an Open questions/risks section (unlike the lightweight path)", () => {
  // COMPLIANT_BODY carries no Open questions/risks section at all; the
  // tracker-backed contract (copilot-loop-operations.md) never names one.
  const result = validateTrackerBackedPrBodySpec({ body: COMPLIANT_BODY, closingIssues: [900] });
  assert.equal(result.ok, true);
  assert.ok(!result.errors.some((e) => e.code === "missing_open_questions"));
});

test("validateTrackerBackedPrBodySpec: missing Acceptance criteria checkboxes fails closed (AC1)", () => {
  const body = COMPLIANT_BODY.replace("## Acceptance criteria\n- [ ] the feature works\n\n", "");
  const result = validateTrackerBackedPrBodySpec({ body, closingIssues: [900] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_acceptance_criteria"));
});

test("validateTrackerBackedPrBodySpec: missing Definition of done checkboxes fails closed (AC1)", () => {
  const body = COMPLIANT_BODY.replace("## Definition of done\n- [ ] npm run verify is green\n", "");
  const result = validateTrackerBackedPrBodySpec({ body, closingIssues: [900] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_definition_of_done"));
});

test("validateTrackerBackedPrBodySpec: missing an explicit Non-goals section fails closed (AC1)", () => {
  const body = COMPLIANT_BODY.replace("## Explicit non-goals\n- unrelated cleanup\n\n", "");
  const result = validateTrackerBackedPrBodySpec({ body, closingIssues: [900] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_explicit_non_goals"));
});

test("validateTrackerBackedPrBodySpec: missing Closes #N fails closed (AC1)", () => {
  const body = COMPLIANT_BODY.replace("Closes #900\n\n", "");
  const result = validateTrackerBackedPrBodySpec({ body, closingIssues: [900] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_closing_issue_reference"));
});

test("validateTrackerBackedPrBodySpec: a real smoke-test-audit-style body (summary + scope + Closes #N only) fails closed on every missing invariant", () => {
  // Mirrors the rc.7 shape the smoke-test audit found: summary + scope +
  // Closes #N, but no AC/DoD checklists and no Non-goals section at all.
  const body = "Closes #900\n\nShips the feature. Scope: touches src/foo.mjs only.\n";
  const result = validateTrackerBackedPrBodySpec({ body, closingIssues: [900] });
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, [
    "missing_acceptance_criteria",
    "missing_definition_of_done",
    "missing_explicit_non_goals",
    "missing_in_scope",
    "missing_objective",
  ]);
});

test("validateTrackerBackedPrBodySpec: AC/DoD rendered as backticked text (not real checkboxes) still fails closed", () => {
  const body = COMPLIANT_BODY
    .replace("- [ ] the feature works", "`- [ ] the feature works`")
    .replace("- [ ] npm run verify is green", "`- [ ] npm run verify is green`");
  const result = validateTrackerBackedPrBodySpec({ body, closingIssues: [900] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_acceptance_criteria"));
  assert.ok(result.errors.some((e) => e.code === "missing_definition_of_done"));
});

test("validateTrackerBackedPrBodySpec: AC/DoD rendered inside a table cell (not a real list item) still fails closed", () => {
  const body = COMPLIANT_BODY
    .replace("- [ ] the feature works", "| - [ ] the feature works |")
    .replace("- [ ] npm run verify is green", "| - [ ] npm run verify is green |");
  const result = validateTrackerBackedPrBodySpec({ body, closingIssues: [900] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_acceptance_criteria"));
  assert.ok(result.errors.some((e) => e.code === "missing_definition_of_done"));
});

test("validateTrackerBackedPrBodySpec: an umbrella PR (multiple closing issues) does not require naming a single expectedIssue", () => {
  const body = COMPLIANT_BODY.replace("Closes #900", "Closes #900, Closes #901");
  const result = validateTrackerBackedPrBodySpec({ body, closingIssues: [900, 901] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.closesIssues.sort(), [900, 901]);
});

test("validateTrackerBackedPrBodySpec: a single-issue PR closing the WRONG issue fails closed with closes_wrong_issue", () => {
  const result = validateTrackerBackedPrBodySpec({ body: COMPLIANT_BODY, closingIssues: [901] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "closes_wrong_issue"));
});

test("validateTrackerBackedPrBodySpec: reuses validatePrBodySpec verbatim (requireOpenQuestions:false) rather than a second checker", () => {
  const direct = validatePrBodySpec({ body: COMPLIANT_BODY, expectedIssue: 900, requireOpenQuestions: false });
  const viaWrapper = validateTrackerBackedPrBodySpec({ body: COMPLIANT_BODY, closingIssues: [900] });
  assert.deepEqual(viaWrapper, direct);
});

// ---------------------------------------------------------------------------
// Regression guard: the lightweight/issue-less path is unchanged (default
// requireOpenQuestions:true still applies when the caller does not opt out).
// ---------------------------------------------------------------------------

test("REGRESSION: validatePrBodySpec still requires Open questions/risks by default (lightweight path unchanged)", () => {
  const body = COMPLIANT_BODY; // no Open questions/risks section
  const result = validatePrBodySpec({ body, expectedIssue: 900 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_open_questions"));
});

test("REGRESSION: validatePrBodySpec({ requireOpenQuestions: true }) is byte-identical to the pre-#1863 default", () => {
  const withDefault = validatePrBodySpec({ body: COMPLIANT_BODY, expectedIssue: 900 });
  const withExplicitTrue = validatePrBodySpec({ body: COMPLIANT_BODY, expectedIssue: 900, requireOpenQuestions: true });
  assert.deepEqual(withDefault, withExplicitTrue);
});
