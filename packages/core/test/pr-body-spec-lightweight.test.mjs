import assert from "node:assert/strict";
import test from "node:test";

import { validatePrBodySpec } from "../src/loop/issue-refinement-artifact.mjs";
import {
  buildDevLoopHandoffEnvelope,
  validateHandoffEnvelope,
  CANONICAL_SPEC_SOURCE,
} from "../src/loop/handoff-envelope.mjs";

// ---------------------------------------------------------------------------
// (b) PR-body-as-spec validation
// ---------------------------------------------------------------------------

const COMPLETE_BODY = `## Objective
Ship the lightweight path because reasons.

## In scope
- the lightweight modifier

## Explicit non-goals
- rewriting the phase-doc path

## Acceptance criteria
- [ ] The PR body is the spec-of-record

## Definition of done
- [ ] npm run verify is green

## Open questions / risks
- none
`;

test("validatePrBodySpec: a complete PR body passes with no errors", () => {
  const result = validatePrBodySpec({ body: COMPLETE_BODY });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.acItems, ["The PR body is the spec-of-record"]);
  assert.deepEqual(result.dodItems, ["npm run verify is green"]);
});

const MISSING_CASES = [
  ["## Objective", "missing_objective"],
  ["## In scope", "missing_in_scope"],
  ["## Explicit non-goals", "missing_explicit_non_goals"],
  ["## Acceptance criteria", "missing_acceptance_criteria"],
  ["## Definition of done", "missing_definition_of_done"],
  ["## Open questions / risks", "missing_open_questions"],
];

for (const [heading, code] of MISSING_CASES) {
  test(`validatePrBodySpec: dropping "${heading}" fails closed with ${code}`, () => {
    // Remove the whole section (heading + body up to the next heading).
    const escaped = heading.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
    const stripped = COMPLETE_BODY.replace(new RegExp(`${escaped}[\\s\\S]*?(?=\\n## |$)`, "u"), "");
    const result = validatePrBodySpec({ body: stripped });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.code === code),
      `expected error code ${code}, got ${JSON.stringify(result.errors.map((e) => e.code))}`,
    );
  });
}

test("validatePrBodySpec: an empty body reports every missing invariant", () => {
  const result = validatePrBodySpec({ body: "" });
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, [
    "missing_acceptance_criteria",
    "missing_definition_of_done",
    "missing_explicit_non_goals",
    "missing_in_scope",
    "missing_objective",
    "missing_open_questions",
  ]);
});

test("validatePrBodySpec: an AC section with only an empty placeholder is not testable", () => {
  const body = COMPLETE_BODY.replace("- [ ] The PR body is the spec-of-record", "- [ ]");
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_acceptance_criteria"));
});

test("validatePrBodySpec: headings buried inside a fenced code block do NOT satisfy the gate (no spoof)", () => {
  // Every invariant heading is real-looking but lives inside a ``` fence.
  const body = "Here is what a good body looks like:\n\n```md\n" + COMPLETE_BODY + "\n```\n";
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, [
    "missing_acceptance_criteria",
    "missing_definition_of_done",
    "missing_explicit_non_goals",
    "missing_in_scope",
    "missing_objective",
    "missing_open_questions",
  ]);
});

// ---------------------------------------------------------------------------
// Shared envelope fixtures
// ---------------------------------------------------------------------------

const LOCAL_BUNDLE = {
  selectedStrategy: "local_implementation",
  executionMode: "bounded_handoff",
  nextAction: "implement the change",
  repoSlug: "owner/name",
  canonicalState: { target: { kind: "local_phase", issue: 1025 } },
};

function buildEnvelope({ lightweight = false } = {}) {
  const resolverOutput = {
    bundle: LOCAL_BUNDLE,
    requiredReads: ["skills/local-implementation/SKILL.md"],
    ...(lightweight ? { canonicalSpecSource: CANONICAL_SPEC_SOURCE.PR_BODY } : {}),
  };
  return buildDevLoopHandoffEnvelope(resolverOutput, {}, {}, {}, new Date("2026-07-04T00:00:00.000Z"));
}

// ---------------------------------------------------------------------------
// (c) acceptance-template variant text
// ---------------------------------------------------------------------------

test("acceptance template: default local_implementation criterion cites the phase doc", () => {
  const env = buildEnvelope();
  assert.equal(
    env.acceptance.criteria[0].must,
    "All phase acceptance criteria from the active phase doc are satisfied.",
  );
});

test("acceptance template: lightweight criterion cites the PR description instead", () => {
  const env = buildEnvelope({ lightweight: true });
  assert.equal(
    env.acceptance.criteria[0].must,
    "All phase acceptance criteria from the PR description are satisfied.",
  );
});

// ---------------------------------------------------------------------------
// (d) envelope carries specSource + validateHandoffEnvelope
// ---------------------------------------------------------------------------

test("envelope: lightweight carries specSource=pr_body", () => {
  const env = buildEnvelope({ lightweight: true });
  assert.equal(env.specSource, CANONICAL_SPEC_SOURCE.PR_BODY);
});

test("validateHandoffEnvelope: accepts a valid specSource", () => {
  const env = buildEnvelope({ lightweight: true });
  assert.equal(validateHandoffEnvelope(env).ok, true);
});

test("validateHandoffEnvelope: rejects an unknown specSource", () => {
  const env = { ...buildEnvelope({ lightweight: true }), specSource: "bogus" };
  const result = validateHandoffEnvelope(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === "specSource"));
});

test("validateHandoffEnvelope: accepts the explicit phase_doc value", () => {
  const env = { ...buildEnvelope(), specSource: CANONICAL_SPEC_SOURCE.PHASE_DOC };
  assert.equal(validateHandoffEnvelope(env).ok, true);
});

test("deriveSpecSource coerces the tracker-backed value to null (no self-rejecting envelope)", () => {
  // "tracker_issue" is carried by the same field name in tracker-backed mode but
  // is outside the envelope's local-first subset — it must not leak into specSource.
  const env = buildDevLoopHandoffEnvelope(
    { bundle: { ...LOCAL_BUNDLE, canonicalSpecSource: "tracker_issue" }, requiredReads: ["x"] },
    {},
    {},
    {},
    new Date("2026-07-04T00:00:00.000Z"),
  );
  assert.equal("specSource" in env, false);
  assert.equal(validateHandoffEnvelope(env).ok, true);
});

// ---------------------------------------------------------------------------
// Additive / unchanged-default proof
// ---------------------------------------------------------------------------

test("ADDITIVE: the default (non-lightweight) envelope carries no specSource field and its acceptance is unchanged", () => {
  const env = buildEnvelope();
  assert.equal("specSource" in env, false);
  assert.equal(
    env.acceptance.criteria[0].must,
    "All phase acceptance criteria from the active phase doc are satisfied.",
  );
  // The lightweight modifier only adds specSource + retargets the phase-ac text;
  // the rest of the envelope is byte-identical to the default. Prove it by
  // deleting the two lightweight-only differences and deep-equaling.
  const lite = buildEnvelope({ lightweight: true });
  const liteNormalized = { ...lite };
  delete liteNormalized.specSource;
  liteNormalized.acceptance = {
    ...lite.acceptance,
    criteria: lite.acceptance.criteria.map((c) => ({
      ...c,
      must: c.must.replace("from the PR description", "from the active phase doc"),
    })),
  };
  assert.deepEqual(liteNormalized, env);
});
