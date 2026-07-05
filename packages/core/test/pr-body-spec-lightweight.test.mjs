import assert from "node:assert/strict";
import test from "node:test";

import { validatePrBodySpec, parseMarkdownSections } from "../src/loop/issue-refinement-artifact.mjs";
import {
  buildDevLoopHandoffEnvelope,
  validateHandoffEnvelope,
  CANONICAL_SPEC_SOURCE,
} from "../src/loop/handoff-envelope.mjs";

// ---------------------------------------------------------------------------
// (b) PR-body-as-spec validation
// ---------------------------------------------------------------------------

const COMPLETE_BODY = `Closes #123

## Objective
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
    "missing_closing_issue_reference",
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

// ---------------------------------------------------------------------------
// Closing-issue-reference invariant (issue #1181)
// ---------------------------------------------------------------------------

test("validatePrBodySpec: a body with Closes #N passes and extracts closesIssues", () => {
  const result = validatePrBodySpec({ body: COMPLETE_BODY });
  assert.equal(result.ok, true);
  assert.deepEqual(result.closesIssues, [123]);
});

test("validatePrBodySpec: no closing-keyword reference fails closed with missing_closing_issue_reference", () => {
  const body = COMPLETE_BODY.replace("Closes #123\n\n", "");
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_closing_issue_reference"));
  assert.deepEqual(result.closesIssues, []);
});

const CLOSING_KEYWORD_VARIANTS = ["Closes #123", "Fixes #123", "closed #123", "RESOLVES #123", "fixed #123", "resolve #123"];

for (const reference of CLOSING_KEYWORD_VARIANTS) {
  test(`validatePrBodySpec: closing keyword variant "${reference}" is accepted`, () => {
    const body = COMPLETE_BODY.replace("Closes #123", reference);
    const result = validatePrBodySpec({ body });
    assert.equal(result.ok, true);
    assert.deepEqual(result.closesIssues, [123]);
  });
}

test("validatePrBodySpec: the cross-repo owner/repo#N form is accepted", () => {
  const body = COMPLETE_BODY.replace("Closes #123", "Closes octocat/Hello-World#123");
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, true);
  assert.deepEqual(result.closesIssues, [123]);
});

test("validatePrBodySpec: expectedIssue matching the closing reference passes", () => {
  const result = validatePrBodySpec({ body: COMPLETE_BODY, expectedIssue: 123 });
  assert.equal(result.ok, true);
});

test("validatePrBodySpec: expectedIssue NOT among the closing references fails closed with closes_wrong_issue", () => {
  const result = validatePrBodySpec({ body: COMPLETE_BODY, expectedIssue: 456 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "closes_wrong_issue"));
});

test("validatePrBodySpec: a fenced Closes #N does NOT satisfy the gate (no spoof)", () => {
  const body = COMPLETE_BODY.replace("Closes #123", "```\nCloses #123\n```");
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_closing_issue_reference"));
});

test("validatePrBodySpec: an inline-code-span-only `Closes #N` does NOT satisfy the gate (no spoof)", () => {
  // GitHub does not auto-close from code-quoted keywords; neither may the gate.
  const body = COMPLETE_BODY.replace("Closes #123", "`Closes #999`");
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "missing_closing_issue_reference"));
  assert.deepEqual(result.closesIssues, []);
});

test("validatePrBodySpec: a real Closes plus an inline-quoted one extracts ONLY the real reference", () => {
  const body = COMPLETE_BODY.replace(
    "Closes #123",
    "Closes #1181\n\nSee also the literal text `Closes #999` in the docs.",
  );
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, true);
  assert.deepEqual(result.closesIssues, [1181]);
});

test("validatePrBodySpec: a multi-backtick inline span (``a `b` c``) is stripped as one span", () => {
  const body = COMPLETE_BODY.replace("Closes #123", "``example: `Closes #999` quoted``");
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, false);
  assert.deepEqual(result.closesIssues, []);
});

const ALL_MISSING = [
  "missing_acceptance_criteria",
  "missing_closing_issue_reference",
  "missing_definition_of_done",
  "missing_explicit_non_goals",
  "missing_in_scope",
  "missing_objective",
  "missing_open_questions",
];

test("validatePrBodySpec: headings buried inside a fenced code block do NOT satisfy the gate (no spoof)", () => {
  // Every invariant heading is real-looking but lives inside a ``` fence.
  const body = "Here is what a good body looks like:\n\n```md\n" + COMPLETE_BODY + "\n```\n";
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code).sort(), ALL_MISSING);
});

test("validatePrBodySpec: a 4-backtick fence is NOT closed by a 3-backtick line inside it (fence-length spoof)", () => {
  // The inner ``` line must NOT close the ```` fence — otherwise the headings
  // after it get counted and the spoof re-opens.
  const body = "````md\n" + COMPLETE_BODY + "\n```\nstill inside the outer fence\n````\n";
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code).sort(), ALL_MISSING);
});

test("validatePrBodySpec: a real body that CONTAINS a fenced code block still validates (no over-strip)", () => {
  const body = COMPLETE_BODY + "\nExample:\n\n```js\n// # Not a real heading, just code\nconst x = 1;\n```\n";
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validatePrBodySpec: a LEADING fenced block closes correctly; all invariant sections AFTER it are detected", () => {
  // A ``` fence up front (with a heading-like line inside) must CLOSE on its
  // ```, so the six real ## sections that follow are counted — guards both
  // "fence closes" and "no over-strip of post-fence sections".
  const body = "```sh\n# not a heading\necho hi\n```\n\n" + COMPLETE_BODY;
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.acItems, ["The PR body is the spec-of-record"]);
  assert.deepEqual(result.dodItems, ["npm run verify is green"]);
  for (const name of ["Objective", "In scope", "Explicit non-goals", "Acceptance criteria", "Definition of done", "Open questions / risks"]) {
    assert.ok(result.sections.includes(name), `expected section ${name} post-fence, got ${JSON.stringify(result.sections)}`);
  }
});

test("parseMarkdownSections: a mixed-marker line (```~~~) does NOT close a backtick fence", () => {
  const sections = parseMarkdownSections("```\n# Fake\n```~~~\n# Exposed\n```\n# Real");
  const names = sections.map((s) => s.name);
  assert.deepEqual(names, ["Real"]);
});

test("validatePrBodySpec: AC/DoD checkboxes that live ONLY inside a code fence do NOT count (fails closed)", () => {
  const body = `Closes #123

## Objective
x
## In scope
- a
## Explicit non-goals
- b
## Acceptance criteria
\`\`\`
- [ ] fenced fake criterion
\`\`\`
## Definition of done
\`\`\`
- [ ] fenced fake dod
\`\`\`
## Open questions / risks
- none
`;
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ["missing_acceptance_criteria", "missing_definition_of_done"]);
  assert.deepEqual(result.acItems, []);
  assert.deepEqual(result.dodItems, []);
});

test("validatePrBodySpec: a narrative section whose body is ONLY a fenced block is treated as empty (fails closed)", () => {
  const body = `Closes #123

## Objective
\`\`\`
just a code block, no real objective prose
\`\`\`
## In scope
- a
## Explicit non-goals
- b
## Acceptance criteria
- [ ] c
## Definition of done
- [ ] d
## Open questions / risks
- none
`;
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code), ["missing_objective"]);
});

test("validatePrBodySpec: real prose plus an ADDITIONAL fenced example still counts as a non-empty section", () => {
  const body = `Closes #123

## Objective
We ship the lightweight path. Example config:
\`\`\`
key: value
\`\`\`
## In scope
- a
## Explicit non-goals
- b
## Acceptance criteria
- [ ] c
## Definition of done
- [ ] d
## Open questions / risks
- none
`;
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validatePrBodySpec: a mix of fenced and real checkboxes counts ONLY the real ones", () => {
  const body = `Closes #123

## Objective
x
## In scope
- a
## Explicit non-goals
- b
## Acceptance criteria
\`\`\`
- [ ] fenced fake criterion
\`\`\`
- [ ] real criterion
## Definition of done
- [ ] real dod
## Open questions / risks
- none
`;
  const result = validatePrBodySpec({ body });
  assert.equal(result.ok, true);
  assert.deepEqual(result.acItems, ["real criterion"]);
  assert.deepEqual(result.dodItems, ["real dod"]);
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
