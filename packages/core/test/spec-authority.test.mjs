import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  SPEC_AUTHORITY_OUTCOMES,
  SPEC_AUTHORITY_OUTCOME_VALUES,
  HUMAN_SPEC_DECISION_OUTCOME,
  outcomeRequiresHumanDecision,
  normalizeSpec,
  specCriterionIds,
  computeSpecDigest,
  computeContentDigest,
  buildRevisionIdentity,
  validateSpecAuthorityDecision,
  validateSpecAuthorityVerdict,
  resolveCriterionInvalidation,
  resolveAffectedCriteria,
  stampSpecAuthorityIdentity,
  extractSpecFromBody,
} from "@dev-loops/core/loop/spec-authority";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const SPEC = {
  acceptanceCriteria: ["Remove repetitive A/B contrast scaffolding", "Ship a working demo"],
  definitionOfDone: ["npm run verify passes"],
  nonGoals: ["Do not flatten the decks' voice or product identity"],
};

function identities(spec = SPEC, headSha = HEAD_A, content = "impl-v1") {
  return buildRevisionIdentity({ spec, headSha, content });
}

function wholeSpecDecision(spec, overrides = {}) {
  return {
    index: 0,
    outcome: SPEC_AUTHORITY_OUTCOMES.VALID_COMPLIANT,
    checkedCriteria: specCriterionIds(spec),
    rationale: "evaluated against the whole spec",
    authorizedRemediation: "apply the compliant fix",
    ...overrides,
  };
}

describe("revision identities", () => {
  test("specDigest is deterministic and normalization-stable", () => {
    const a = computeSpecDigest(SPEC);
    const reordered = { ...SPEC, acceptanceCriteria: SPEC.acceptanceCriteria.map((s) => `  ${s}  `) };
    assert.equal(computeSpecDigest(reordered), a, "whitespace-only variation must not change the digest");
    assert.match(a, /^sha256:[0-9a-f]{64}$/);
  });

  test("a spec text change yields a new specDigest", () => {
    const changed = { ...SPEC, acceptanceCriteria: [...SPEC.acceptanceCriteria, "New AC"] };
    assert.notEqual(computeSpecDigest(changed), computeSpecDigest(SPEC));
  });

  test("specDigest is never derived from headSha; content digest is a distinct identity", () => {
    const { specDigest, headSha, contentDigest } = identities();
    assert.notEqual(specDigest, contentDigest);
    assert.ok(!specDigest.includes(headSha), "specDigest must not embed the head SHA");
    // Reviewing the same spec at a different head does not change the specDigest.
    const other = buildRevisionIdentity({ spec: SPEC, headSha: HEAD_B, content: "impl-v1" });
    assert.equal(other.specDigest, specDigest);
    // A content change moves the content digest but not the spec digest.
    const contentChanged = buildRevisionIdentity({ spec: SPEC, headSha: HEAD_A, content: "impl-v2" });
    assert.equal(contentChanged.specDigest, specDigest);
    assert.notEqual(contentChanged.contentDigest, contentDigest);
  });

  test("specCriterionIds always normalizes — a raw spec with empty items does not yield phantom ids that diverge from the digest", () => {
    const raw = {
      acceptanceCriteria: ["real ac", "   ", "second ac"],
      definitionOfDone: [""],
      nonGoals: ["  keep voice  "],
    };
    // The empty/whitespace items are dropped, so ids match the normalized shape
    // (2 AC + 0 DoD + 1 non-goal), NOT the raw array lengths.
    assert.deepEqual(specCriterionIds(raw), ["ac:0", "ac:1", "ng:0"]);
    // And the id count matches computeSpecDigest's normalized view of the same input.
    assert.equal(specCriterionIds(raw).length, specCriterionIds(normalizeSpec(raw)).length);
  });

  test("normalizeSpec fails closed on a spec with no acceptance criteria", () => {
    assert.throws(() => normalizeSpec({ acceptanceCriteria: [], definitionOfDone: ["x"], nonGoals: [] }), /no acceptance criteria/);
  });

  test("buildRevisionIdentity rejects a non-hex head SHA", () => {
    assert.throws(() => buildRevisionIdentity({ spec: SPEC, headSha: "not-a-sha", content: "x" }), /hex git SHA/);
  });

  test("buildRevisionIdentity fails closed when specDigest and contentDigest collide", () => {
    const d = computeSpecDigest(SPEC);
    assert.throws(() => buildRevisionIdentity({ specDigest: d, headSha: HEAD_A, contentDigest: d }), /distinct identities/);
  });

  test("buildRevisionIdentity fails closed when specDigest is the head SHA", () => {
    assert.throws(
      () => buildRevisionIdentity({ specDigest: `sha256:${HEAD_A.padEnd(64, "0")}`, headSha: HEAD_A.padEnd(64, "0"), content: "x" }),
      /must not be derived from|embed headSha/,
    );
  });

  test("buildRevisionIdentity rejects a specDigest that EMBEDS a normal 40-hex head SHA (guard is not a no-op)", () => {
    const sha = "a".repeat(40);
    // A 64-hex body that embeds the 40-hex head SHA — the exact-equality-only
    // guard would have missed this; the substring guard catches it.
    const embedding = `sha256:${sha}${"b".repeat(24)}`;
    assert.throws(() => buildRevisionIdentity({ specDigest: embedding, headSha: sha, content: "x" }), /embed headSha/);
  });
});

describe("whole-spec judge disposition", () => {
  test("all four named outcomes are exported and only spec_cannot_decide escalates", () => {
    assert.deepEqual(
      SPEC_AUTHORITY_OUTCOME_VALUES,
      ["valid_compliant", "finding_conflicts", "remediation_conflicts", "spec_cannot_decide"],
    );
    assert.equal(HUMAN_SPEC_DECISION_OUTCOME, "spec_cannot_decide");
    assert.equal(outcomeRequiresHumanDecision("spec_cannot_decide"), true);
    for (const o of ["valid_compliant", "finding_conflicts", "remediation_conflicts"]) {
      assert.equal(outcomeRequiresHumanDecision(o), false);
    }
  });

  test("a supportive-only / partial criterion citation cannot produce a valid disposition", () => {
    const id = identities();
    const partial = {
      ...wholeSpecDecision(SPEC),
      ...id,
      checkedCriteria: ["ac:0"], // only one supportive criterion
    };
    assert.throws(
      () => validateSpecAuthorityDecision(partial, { ...id, criterionIds: specCriterionIds(SPEC) }),
      /whole spec|uncovered/,
    );
  });

  test("a whole-spec valid_compliant decision is accepted", () => {
    const id = identities();
    const decision = { ...wholeSpecDecision(SPEC), ...id };
    const out = validateSpecAuthorityDecision(decision, { ...id, criterionIds: specCriterionIds(SPEC) });
    assert.equal(out.outcome, "valid_compliant");
    assert.equal(out.requiresHumanDecision, false);
    assert.equal(out.authorizedRemediation, "apply the compliant fix");
  });

  test("valid_compliant requires an authorized (compliant) remediation", () => {
    const id = identities();
    const decision = { ...wholeSpecDecision(SPEC), ...id, authorizedRemediation: "" };
    assert.throws(() => validateSpecAuthorityDecision(decision, { ...id, criterionIds: specCriterionIds(SPEC) }), /authorizedRemediation/);
  });

  test("conflict outcomes require explicit conflicting criteria", () => {
    const id = identities();
    const base = {
      ...wholeSpecDecision(SPEC),
      ...id,
      outcome: SPEC_AUTHORITY_OUTCOMES.FINDING_CONFLICTS,
      authorizedRemediation: undefined,
    };
    assert.throws(() => validateSpecAuthorityDecision(base, { ...id, criterionIds: specCriterionIds(SPEC) }), /conflictingCriteria/);
    const ok = validateSpecAuthorityDecision(
      { ...base, conflictingCriteria: ["ng:0"] },
      { ...id, criterionIds: specCriterionIds(SPEC) },
    );
    assert.deepEqual(ok.conflictingCriteria, ["ng:0"]);
  });

  test("a non-conflict outcome must not smuggle a conflict list", () => {
    const id = identities();
    const decision = { ...wholeSpecDecision(SPEC), ...id, conflictingCriteria: ["ng:0"] };
    assert.throws(() => validateSpecAuthorityDecision(decision, { ...id, criterionIds: specCriterionIds(SPEC) }), /must not carry conflictingCriteria/);
  });

  test("a stale specDigest / headSha / contentDigest fails closed", () => {
    const id = identities();
    const ctx = { ...id, criterionIds: specCriterionIds(SPEC) };
    assert.throws(
      () => validateSpecAuthorityDecision({ ...wholeSpecDecision(SPEC), ...id, specDigest: computeSpecDigest({ ...SPEC, nonGoals: ["different"] }) }, ctx),
      /specDigest is stale/,
    );
    assert.throws(
      () => validateSpecAuthorityDecision({ ...wholeSpecDecision(SPEC), ...id, headSha: HEAD_B }, ctx),
      /headSha is stale/,
    );
    assert.throws(
      () => validateSpecAuthorityDecision({ ...wholeSpecDecision(SPEC), ...id, contentDigest: computeContentDigest("other") }, ctx),
      /contentDigest is stale/,
    );
  });
});

describe("verdict-level coverage and escalation", () => {
  test("every finding must be disposed exactly once", () => {
    const id = identities();
    const verdict = { ...id, decisions: [{ ...wholeSpecDecision(SPEC), ...id, index: 0 }] };
    assert.throws(
      () => validateSpecAuthorityVerdict(verdict, { findingsCount: 2, criterionIds: specCriterionIds(SPEC) }),
      /does not dispose/,
    );
  });

  test("a duplicate disposition for one finding fails closed", () => {
    const id = identities();
    const d = { ...wholeSpecDecision(SPEC), ...id };
    const verdict = { ...id, decisions: [{ ...d, index: 0 }, { ...d, index: 0 }] };
    assert.throws(() => validateSpecAuthorityVerdict(verdict, { findingsCount: 1, criterionIds: specCriterionIds(SPEC) }), /duplicate decision/);
  });

  test("decisions and humanDecisionIndices are returned in canonical (index-sorted) order regardless of submission order", () => {
    const id = identities();
    const mk = (index, outcome, extra = {}) => ({
      ...id, index, outcome, checkedCriteria: specCriterionIds(SPEC), rationale: "r", ...extra,
    });
    // Submit out of order: index 2 (human), then 0, then 1.
    const decisions = [
      mk(2, SPEC_AUTHORITY_OUTCOMES.SPEC_CANNOT_DECIDE),
      mk(0, SPEC_AUTHORITY_OUTCOMES.VALID_COMPLIANT, { authorizedRemediation: "x" }),
      mk(1, SPEC_AUTHORITY_OUTCOMES.SPEC_CANNOT_DECIDE),
    ];
    const out = validateSpecAuthorityVerdict({ ...id, decisions }, { findingsCount: 3, criterionIds: specCriterionIds(SPEC) });
    assert.deepEqual(out.decisions.map((d) => d.index), [0, 1, 2]);
    assert.deepEqual(out.humanDecisionIndices, [1, 2]);
  });

  test("a spec_cannot_decide decision surfaces the human-decision requirement", () => {
    const id = identities();
    const decisions = [
      { ...wholeSpecDecision(SPEC), ...id, index: 0 },
      {
        ...id,
        index: 1,
        outcome: SPEC_AUTHORITY_OUTCOMES.SPEC_CANNOT_DECIDE,
        checkedCriteria: specCriterionIds(SPEC),
        rationale: "the spec is internally contradictory on voice vs deduplication",
      },
    ];
    const out = validateSpecAuthorityVerdict({ ...id, decisions }, { findingsCount: 2, criterionIds: specCriterionIds(SPEC) });
    assert.equal(out.humanDecisionRequired, true);
    assert.deepEqual(out.humanDecisionIndices, [1]);
    assert.equal(out.outcomeCounts.spec_cannot_decide, 1);
  });
});

describe("revision-scoped invalidation", () => {
  const specDigest = computeSpecDigest(SPEC);
  const approved = specCriterionIds(SPEC);

  test("a spec change (new specDigest) stales every prior-derived approval", () => {
    const newDigest = computeSpecDigest({ ...SPEC, acceptanceCriteria: [...SPEC.acceptanceCriteria, "extra"] });
    const out = resolveCriterionInvalidation({
      priorSpecDigest: specDigest,
      currentSpecDigest: newDigest,
      priorApprovedCriteria: approved,
    });
    assert.equal(out.specChanged, true);
    assert.deepEqual(out.stale.sort(), [...approved].sort());
    assert.deepEqual(out.carried, []);
  });

  test("a fixer push stales only affected criteria; unaffected carry only with positive proof", () => {
    const out = resolveCriterionInvalidation({
      priorSpecDigest: specDigest,
      currentSpecDigest: specDigest,
      priorApprovedCriteria: ["ac:0", "ac:1", "dod:0"],
      affectedCriteria: ["ac:0"],
      carryForwardProof: {
        "ac:1": { specTextUnchanged: true, coveredSurfaceUnchanged: true },
        // dod:0 has no proof -> must fail closed to fresh review
      },
    });
    assert.equal(out.specChanged, false);
    assert.deepEqual(out.carried, ["ac:1"]);
    assert.deepEqual(out.stale.sort(), ["ac:0", "dod:0"]);
  });

  test("unknown / half-proven impact fails closed to fresh review", () => {
    const out = resolveCriterionInvalidation({
      priorSpecDigest: specDigest,
      currentSpecDigest: specDigest,
      priorApprovedCriteria: ["ac:1"],
      affectedCriteria: [],
      carryForwardProof: { "ac:1": { specTextUnchanged: true, coveredSurfaceUnchanged: false } },
    });
    assert.deepEqual(out.carried, []);
    assert.deepEqual(out.stale, ["ac:1"]);
  });
});

describe("spec extraction from a tracker body", () => {
  test("extractSpecFromBody pulls AC/DoD/Non-goals checklist items (no matrix: fallback)", () => {
    const body = [
      "## Acceptance criteria",
      "- [ ] Remove repetitive A/B contrast scaffolding",
      "- [ ] Ship a working demo",
      "## Definition of done",
      "- [ ] npm run verify passes",
      "## Non-goals",
      "- Do not flatten the decks' voice or product identity",
    ].join("\n");
    const spec = extractSpecFromBody(body);
    assert.equal(spec.acceptanceCriteria.length, 2);
    assert.equal(spec.definitionOfDone.length, 1);
    assert.equal(spec.nonGoals.length, 1);
    // Digest of the extracted spec matches the structured spec.
    assert.equal(computeSpecDigest(spec), computeSpecDigest(SPEC));
  });
});

// #2016 regression: the spec identity must be derived from the authoritative
// AC→DoD matrix, not the redundant list-form checklist projection of it. See
// extractSpecFromBody's ponytail comment for the equivalence boundary.
describe("extractSpecFromBody matrix-derived spec identity (#2016)", () => {
  function matrixBody({
    heading = "AC/DoD matrix",
    criterion1 = "Ship a working demo",
    evidence1 = "Demo recorded and linked in the PR description",
    criterion2 = "Verify contrast ratio meets WCAG AA",
    evidence2 = "Automated contrast check passes in CI",
    extraRow = null,
    nonGoal = "Do not rewrite the design system",
    checklistAlias = null,
  } = {}) {
    const rows = [
      `| ${criterion1} | ${evidence1} |`,
      `| ${criterion2} | ${evidence2} |`,
    ];
    if (extraRow) rows.push(extraRow);
    const lines = [
      `## ${heading}`,
      "",
      "| Acceptance criterion | Completion evidence |",
      "|---|---|",
      ...rows,
      "",
      "## Non-goals",
      `- ${nonGoal}`,
    ];
    if (checklistAlias) {
      lines.push("", ...checklistAlias);
    }
    return lines.join("\n");
  }

  test("adding a redundant checklist alias that projects an unchanged matrix leaves specDigest unchanged", () => {
    const withoutAlias = matrixBody();
    const withAlias = matrixBody({
      checklistAlias: [
        "## Acceptance criteria",
        "- [ ] Ship a working demo",
        "- [ ] Verify contrast ratio meets WCAG AA",
      ],
    });
    assert.equal(
      computeSpecDigest(extractSpecFromBody(withAlias)),
      computeSpecDigest(extractSpecFromBody(withoutAlias)),
      "a checklist alias projecting the same matrix must not change specDigest",
    );
  });

  test("removing a redundant checklist alias that projects an unchanged matrix leaves specDigest unchanged", () => {
    const withAlias = matrixBody({
      checklistAlias: ["## Definition of done", "- [ ] Demo recorded and linked in the PR description"],
    });
    const withoutAlias = matrixBody();
    assert.equal(
      computeSpecDigest(extractSpecFromBody(withAlias)),
      computeSpecDigest(extractSpecFromBody(withoutAlias)),
    );
  });

  test("changing a matrix criterion's text changes specDigest", () => {
    const original = matrixBody();
    const reworded = matrixBody({ criterion1: "Ship a fully working demo end to end" });
    assert.notEqual(
      computeSpecDigest(extractSpecFromBody(original)),
      computeSpecDigest(extractSpecFromBody(reworded)),
    );
  });

  test("changing a completion-evidence cell changes specDigest", () => {
    const original = matrixBody();
    const changed = matrixBody({ evidence1: "Demo recorded, linked, and reviewed live" });
    assert.notEqual(
      computeSpecDigest(extractSpecFromBody(original)),
      computeSpecDigest(extractSpecFromBody(changed)),
    );
  });

  test("adding a matrix row changes specDigest", () => {
    const original = matrixBody();
    const withExtraRow = matrixBody({ extraRow: "| Ship documentation updates | Docs page merged and linked |" });
    assert.notEqual(
      computeSpecDigest(extractSpecFromBody(original)),
      computeSpecDigest(extractSpecFromBody(withExtraRow)),
    );
  });

  test("removing a matrix row changes specDigest", () => {
    const withExtraRow = matrixBody({ extraRow: "| Ship documentation updates | Docs page merged and linked |" });
    const original = matrixBody();
    assert.notEqual(
      computeSpecDigest(extractSpecFromBody(withExtraRow)),
      computeSpecDigest(extractSpecFromBody(original)),
    );
  });

  test("changing a Non-goal changes specDigest", () => {
    const original = matrixBody();
    const changedNonGoal = matrixBody({ nonGoal: "Do not change the release cadence" });
    assert.notEqual(
      computeSpecDigest(extractSpecFromBody(original)),
      computeSpecDigest(extractSpecFromBody(changedNonGoal)),
    );
  });

  test("heading/whitespace/checklist-marker normalization with an unchanged matrix leaves specDigest unchanged", () => {
    const original = matrixBody({ heading: "AC/DoD matrix" });
    const normalizedVariant = matrixBody({
      heading: "AC → DoD mapping matrix",
      criterion1: "  Ship   a working   demo  ",
      evidence1: "  Demo recorded and linked in the PR description  ",
      checklistAlias: [
        "## Acceptance criteria",
        "* [ ] Ship a working demo",
        "1) [ ] Verify contrast ratio meets WCAG AA",
      ],
    });
    assert.equal(
      computeSpecDigest(extractSpecFromBody(original)),
      computeSpecDigest(extractSpecFromBody(normalizedVariant)),
    );
  });

  test("a malformed/identifier-only matrix falls back to the checklist projection (fail-closed, not silently narrowed)", () => {
    const body = [
      "## AC/DoD matrix",
      "",
      "| AC | DoD |",
      "|---|---|",
      "| AC1 | D1 |",
      "",
      "## Acceptance criteria",
      "- [ ] Ship a working demo",
      "## Definition of done",
      "- [ ] npm run verify passes",
      "## Non-goals",
      "- Do not rewrite the design system",
    ].join("\n");
    const spec = extractSpecFromBody(body);
    // Falls back to the checklist read rather than the tautological matrix rows.
    assert.deepEqual(spec.acceptanceCriteria, ["Ship a working demo"]);
    assert.deepEqual(spec.definitionOfDone, ["npm run verify passes"]);
  });

  test("a body with no parseable matrix at all falls back to the checklist projection", () => {
    const body = [
      "## Acceptance criteria",
      "- [ ] Ship a working demo",
      "## Definition of done",
      "- [ ] npm run verify passes",
      "## Non-goals",
      "- Do not rewrite the design system",
    ].join("\n");
    const spec = extractSpecFromBody(body);
    assert.deepEqual(spec.acceptanceCriteria, ["Ship a working demo"]);
    assert.deepEqual(spec.definitionOfDone, ["npm run verify passes"]);
  });
});

describe("resolveAffectedCriteria (AC7, issue 2008)", () => {
  const coverage = {
    "ac:0": ["src/dedup.mjs", "src/lib/**"],
    "ac:1": ["src/demo/*.mjs"],
  };

  test("a changed path stales only the criteria whose coverage it matches", () => {
    const out = resolveAffectedCriteria({
      changedPaths: ["src/dedup.mjs", "src/lib/inner/helper.mjs", "src/demo/run.mjs"],
      criterionCoverage: coverage,
    });
    assert.deepEqual(out.affectedCriteria, ["ac:0", "ac:1"]);
    assert.equal(out.uncertain, false);
    assert.deepEqual(out.unmatchedPaths, []);
  });

  test("affectedCriteria is sorted+deduped even with overlapping coverage and repeated paths", () => {
    const out = resolveAffectedCriteria({
      changedPaths: ["src/lib/inner/helper.mjs", "src/lib/inner/helper.mjs"],
      criterionCoverage: { "ng:0": ["src/lib/**"], "ac:0": ["src/lib/**"] },
    });
    assert.deepEqual(out.affectedCriteria, ["ac:0", "ng:0"]);
  });

  test("a changed path matching zero criteria is fail-closed (uncertain, unmatched recorded)", () => {
    const out = resolveAffectedCriteria({
      changedPaths: ["src/dedup.mjs", "docs/unrelated.md"],
      criterionCoverage: coverage,
    });
    assert.deepEqual(out.affectedCriteria, ["ac:0"]);
    assert.equal(out.uncertain, true);
    assert.deepEqual(out.unmatchedPaths, ["docs/unrelated.md"]);
  });

  test("no changed paths is not uncertain (nothing to fail closed over)", () => {
    const out = resolveAffectedCriteria({ changedPaths: [], criterionCoverage: coverage });
    assert.deepEqual(out, { affectedCriteria: [], uncertain: false, unmatchedPaths: [] });
  });

  test("F3 (issue 2008 draft-gate review): a `?` in a coverage glob matches a literal `?` path, not a regex quantifier", () => {
    // "src/a?.mjs*" is not a supported glob token combination on its own —
    // `?` must match the literal character, never "zero-or-one of the
    // preceding token". A path containing the literal `?` must match; the
    // same path with the `?` character dropped must NOT.
    const out = resolveAffectedCriteria({
      changedPaths: ["src/a?.mjsONE", "src/a.mjsTWO"],
      criterionCoverage: { "ac:0": ["src/a?.mjs*"] },
    });
    assert.deepEqual(out.affectedCriteria, ["ac:0"]);
    assert.equal(out.uncertain, true, "the path missing the literal `?` must not match (fails closed as unmatched)");
    assert.deepEqual(out.unmatchedPaths, ["src/a.mjsTWO"]);
  });

  test("a whitespace-padded criterion-map key is trimmed and matched (never under-staled)", () => {
    const out = resolveAffectedCriteria({
      changedPaths: ["src/lib/inner/helper.mjs"],
      criterionCoverage: { " ac:0 ": ["src/lib/**"] },
    });
    assert.deepEqual(out.affectedCriteria, ["ac:0"]);
    assert.equal(out.uncertain, false);
  });

  test("fails closed on malformed input", () => {
    assert.throws(() => resolveAffectedCriteria({ changedPaths: "not-an-array", criterionCoverage: coverage }), /changedPaths must be an array/);
    assert.throws(() => resolveAffectedCriteria({ changedPaths: [""], criterionCoverage: coverage }), /changedPaths\[0\] must be a non-empty string/);
    assert.throws(() => resolveAffectedCriteria({ changedPaths: ["a"], criterionCoverage: null }), /criterionCoverage must be an object/);
    assert.throws(() => resolveAffectedCriteria({ changedPaths: ["a"], criterionCoverage: { "ac:0": "not-an-array" } }), /criterionCoverage\["ac:0"\] must be an array/);
    assert.throws(() => resolveAffectedCriteria({ changedPaths: ["a"], criterionCoverage: { "ac:0": [""] } }), /must be a non-empty glob string/);
  });
});

describe("stampSpecAuthorityIdentity (AC1, issue 2008)", () => {
  const id = identities();
  const checkedCriteria = specCriterionIds(SPEC);

  test("stamps the identity trio + sorted checked criteria under a specAuthority key without mutating the input", () => {
    const record = { foo: "bar" };
    const stamped = stampSpecAuthorityIdentity(record, { ...id, checkedCriteria: [...checkedCriteria].reverse() });
    assert.deepEqual(record, { foo: "bar" }, "input record must not be mutated");
    assert.deepEqual(stamped, {
      foo: "bar",
      specAuthority: { ...id, checkedCriteria: [...checkedCriteria].sort() },
    });
  });

  test("fails closed on a missing/invalid identity", () => {
    assert.throws(() => stampSpecAuthorityIdentity({}, { ...id, specDigest: "not-a-digest" }), /specDigest/);
    assert.throws(() => stampSpecAuthorityIdentity({}, { ...id, headSha: "zz" }), /hex git SHA/);
    assert.throws(() => stampSpecAuthorityIdentity({}, { ...id, contentDigest: undefined }), /contentDigest/);
    assert.throws(() => stampSpecAuthorityIdentity({}, { ...id, checkedCriteria: "nope" }), /checkedCriteria must be an array/);
  });

  test("fails closed on a non-object record", () => {
    assert.throws(() => stampSpecAuthorityIdentity(null, { ...id, checkedCriteria }), /record must be an object/);
    assert.throws(() => stampSpecAuthorityIdentity([1, 2], { ...id, checkedCriteria }), /record must be an object/);
  });
});

// Regression fixture combining "remove repetitive A/B rhetoric" with "preserve
// voice / product identity": a flattening finding/remedy is autonomously
// rejected, a valid repetition finding routes to a voice-preserving alternative,
// and only a deliberately contradictory spec escalates to a human decision.
describe("deduplication-vs-voice regression fixture", () => {
  const id = identities();
  const criterionIds = specCriterionIds(SPEC); // ac:0 dedup, ac:1 demo, dod:0 verify, ng:0 preserve-voice
  const ctx = { ...id, criterionIds };

  test("a flattening finding is autonomously rejected against the preserve-voice non-goal", () => {
    const decision = validateSpecAuthorityDecision(
      {
        index: 0,
        ...id,
        outcome: SPEC_AUTHORITY_OUTCOMES.FINDING_CONFLICTS,
        checkedCriteria: criterionIds,
        conflictingCriteria: ["ng:0"],
        rationale: "the finding demands flattening the deck voice, which the non-goal forbids",
      },
      ctx,
    );
    assert.equal(decision.outcome, "finding_conflicts");
    assert.equal(decision.requiresHumanDecision, false, "an ordinary conflict resolves autonomously, no human escalation");
  });

  test("a valid repetition finding whose proposed remedy flattens routes to a compliant alternative", () => {
    const decision = validateSpecAuthorityDecision(
      {
        index: 0,
        ...id,
        outcome: SPEC_AUTHORITY_OUTCOMES.REMEDIATION_CONFLICTS,
        checkedCriteria: criterionIds,
        conflictingCriteria: ["ng:0"],
        rationale: "repetition is real (ac:0) but the proposed rewrite flattens voice (ng:0) — keep finding, route to a voice-preserving dedup",
        rejectedRemediations: ["delete all contrast framing"],
      },
      ctx,
    );
    assert.equal(decision.outcome, "remediation_conflicts");
    assert.equal(decision.requiresHumanDecision, false);
    assert.deepEqual(decision.rejectedRemediations, ["delete all contrast framing"]);
  });

  test("only a deliberately contradictory spec escalates to a human decision", () => {
    const contradictory = {
      acceptanceCriteria: ["Delete every contrast sentence", "Keep every contrast sentence verbatim"],
      definitionOfDone: ["ship"],
      nonGoals: ["change nothing"],
    };
    const cid = buildRevisionIdentity({ spec: contradictory, headSha: HEAD_A, content: "impl" });
    const out = validateSpecAuthorityVerdict(
      {
        ...cid,
        decisions: [
          {
            ...cid,
            index: 0,
            outcome: SPEC_AUTHORITY_OUTCOMES.SPEC_CANNOT_DECIDE,
            checkedCriteria: specCriterionIds(contradictory),
            rationale: "ac:0 and ac:1 are mutually exclusive; compliant action is undecidable without a human spec decision",
          },
        ],
      },
      { findingsCount: 1, criterionIds: specCriterionIds(contradictory) },
    );
    assert.equal(out.humanDecisionRequired, true);
  });
});
