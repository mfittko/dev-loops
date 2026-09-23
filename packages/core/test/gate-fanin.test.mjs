import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  consolidateFanin,
  composeReviewVerdict,
  listOpenActItems,
  toFindingsLogShape,
  planFanoutBatches,
  DEFAULT_MAX_FANOUT_REVIEWERS,
  FANOUT_UNAVAILABLE_MESSAGE,
  fanoutUnavailableError,
  countDistinctReviewers,
  provenanceConsistencyError,
  checkFanoutAngleCoverage,
  checkResolvedAngleEvidence,
  countFreshDispatchUnits,
  fanoutReviewerPairingError,
  freshAngleNames,
  scheduleFanoutWaves,
  backoffMaxConcurrent,
  planDispatchRetry,
  reviewerBudgetPreflight,
  normalizeSeverity,
  applyJudgeDispositions,
  validateJudgeVerdict,
  SCOPE_DRIFT_VERDICTS,
  normalizeScopeDriftVerdict,
  tallySeverities,
  zeroSeverityCounts,
  SEVERITY_ORDER,
  VALID_SEVERITIES,
  NON_DEFECT_SEVERITIES,
  resolveFindingFile,
  hasLocatableShape,
} from "../src/loop/gate-fanin.mjs";
import {
  assertCleanImpliesNoBlockingAct,
  clusterFindings,
  dedupeActListByCluster,
} from "../src/loop/finding-cluster.mjs";

// SEVERITY_ORDER, VALID_SEVERITIES, and NON_DEFECT_SEVERITIES must be frozen
// like this file's other exported vocabulary constants (GATE_CONFIG_KEY,
// LEGACY_SEVERITY_ALIASES, FANIN_SYNTHETIC_ANGLES, JUDGE_DISPOSITIONS) — an
// unfrozen shared array is a footgun a later change could silently corrupt
// for every consumer. Object.freeze on VALID_SEVERITIES/NON_DEFECT_SEVERITIES
// (both Sets) only locks their own properties, not Set.prototype.add/delete,
// so it doesn't block content mutation the way it blocks Array.prototype.push
// on SEVERITY_ORDER below — it's applied for export consistency and to stop
// a stray own-property assignment on the Set object itself.
test("SEVERITY_ORDER, VALID_SEVERITIES, and NON_DEFECT_SEVERITIES are frozen, matching their frozen sibling exports", () => {
  assert.equal(Object.isFrozen(SEVERITY_ORDER), true, "SEVERITY_ORDER must be frozen");
  assert.equal(Object.isFrozen(VALID_SEVERITIES), true, "VALID_SEVERITIES must be frozen");
  assert.equal(Object.isFrozen(NON_DEFECT_SEVERITIES), true, "NON_DEFECT_SEVERITIES must be frozen");
  try {
    assert.throws(() => { SEVERITY_ORDER.push("bogus"); }, TypeError);
  } finally {
    // If the freeze above ever regresses, the push actually succeeds BEFORE
    // assert.throws fails — clean up the pushed entry so that regression
    // fails only THIS test, instead of leaving "bogus" in the shared
    // module-level SEVERITY_ORDER where every later order-dependent test in
    // this file (zeroSeverityCounts/tallySeverities below) would fail too.
    const bogusIndex = SEVERITY_ORDER.indexOf("bogus");
    if (bogusIndex !== -1) SEVERITY_ORDER.splice(bogusIndex, 1);
  }
});

function cleanAngle(angle) {
  return { angle, verdict: "clean", findings: [] };
}

function findingAngle(angle, severity, summary = "issue", extra = {}) {
  return {
    angle,
    verdict: "findings_present",
    findings: [{ severity, summary, ...extra }],
  };
}

describe("normalizeSeverity (trim, case-sensitive, before alias lookup)", () => {
  test("trims incidental whitespace around a canonical value", () => {
    assert.equal(normalizeSeverity("high "), "high");
    assert.equal(normalizeSeverity(" high"), "high");
    assert.equal(normalizeSeverity(" high \t"), "high");
  });

  test("trims whitespace around a legacy spelling before the alias lookup", () => {
    assert.equal(normalizeSeverity(" must-fix "), "high");
    assert.equal(normalizeSeverity("worth-fixing-now\n"), "medium");
  });

  // Deliberately case-SENSITIVE: every sanctioned writer already emits
  // lowercase, so a mixed-case value is a forged/malformed input, not a
  // legitimate variant. Case-folding it here would let a forged
  // "severity=NIT"/"Low" marker silently pass VALID_SEVERITIES and
  // auto-defer-close instead of failing closed as an unrecognized severity.
  test("does NOT lowercase — a mixed-case value stays mixed-case (and so fails VALID_SEVERITIES downstream)", () => {
    assert.equal(normalizeSeverity("HIGH"), "HIGH");
    assert.equal(normalizeSeverity("Must-Fix"), "Must-Fix");
  });

  test("a non-string passes through unchanged (caller's validation rejects it)", () => {
    assert.equal(normalizeSeverity(undefined), undefined);
    assert.equal(normalizeSeverity(null), null);
    assert.equal(normalizeSeverity(42), 42);
  });

  test("an unrecognized value still normalizes (trim only) so every caller sees the same rejected form", () => {
    assert.equal(normalizeSeverity(" Bogus "), "Bogus");
  });
});

describe("zeroSeverityCounts", () => {
  test("returns one zeroed key per SEVERITY_ORDER entry", () => {
    assert.deepEqual(zeroSeverityCounts(), { high: 0, question: 0, medium: 0, low: 0, nit: 0 });
  });

  test("returns a fresh object on every call — mutating one call's result leaves the next call's result untouched", () => {
    const first = zeroSeverityCounts();
    first.high = 99;
    const second = zeroSeverityCounts();
    assert.equal(second.high, 0);
    assert.notEqual(first, second);
  });
});

describe("tallySeverities", () => {
  test("an empty findings list tallies to the zero map", () => {
    assert.deepEqual(tallySeverities([]), zeroSeverityCounts());
  });

  test("counts each finding under its already-canonical severity", () => {
    const counts = tallySeverities([{ severity: "high" }, { severity: "high" }, { severity: "low" }]);
    assert.deepEqual(counts, { high: 2, question: 0, medium: 0, low: 1, nit: 0 });
  });

  test("normalizes a legacy spelling onto its canonical bucket before counting", () => {
    const counts = tallySeverities([
      { severity: "must-fix" },
      { severity: "worth-fixing-now" },
      { severity: "nice-to-have" },
      { severity: "defer" },
    ]);
    assert.deepEqual(counts, { high: 1, question: 0, medium: 1, low: 2, nit: 0 });
  });

  test("an unrecognized severity (after normalization) is excluded from the tally rather than inflating an unknown key", () => {
    const counts = tallySeverities([{ severity: "bogus" }, { severity: "high" }]);
    assert.deepEqual(counts, { high: 1, question: 0, medium: 0, low: 0, nit: 0 });
    assert.deepEqual(Object.keys(counts).sort(), [...SEVERITY_ORDER].sort());
  });

  test("a nullish findings argument throws rather than tallying to a silent zero map", () => {
    assert.throws(() => tallySeverities(undefined));
    assert.throws(() => tallySeverities(null));
  });

  test("a nullish individual finding throws rather than being silently skipped", () => {
    assert.throws(() => tallySeverities([null, { severity: "nit" }]));
    assert.throws(() => tallySeverities([undefined, { severity: "nit" }]));
  });
});

describe("consolidateFanin — verdict", () => {
  test("clean when all angles clean", () => {
    const result = consolidateFanin({
      angleResults: [cleanAngle("scope"), cleanAngle("coverage")],
    });
    assert.equal(result.verdict, "clean");
    assert.equal(result.findings.length, 0);
    assert.equal(result.counts.angles, 2);
    assert.equal(result.counts.blocking, 0);
    assert.deepEqual(result.malformed, []);
  });

  test("findings_present when a blocking-severity finding remains (default high)", () => {
    const result = consolidateFanin({
      angleResults: [cleanAngle("scope"), findingAngle("correctness", "high")],
    });
    assert.equal(result.verdict, "findings_present");
    assert.equal(result.counts.blocking, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].disposition, "accepted-for-fix");
  });

  test("clean when only non-blocking findings remain under default policy", () => {
    const result = consolidateFanin({
      angleResults: [findingAngle("docs", "defer")], // legacy alias input — must normalize
    });
    assert.equal(result.verdict, "clean");
    assert.equal(result.counts.findings, 1);
    assert.equal(result.counts.blocking, 0);
    assert.equal(result.findings[0].severity, "low");
    assert.deepEqual(result.counts.bySeverity, { high: 0, medium: 0, low: 1, question: 0, nit: 0 });
    assert.equal(result.findings[0].disposition, "deferred");
  });

  test("severity gating: medium blocks only when listed", () => {
    const angleResults = [findingAngle("kiss", "medium")];
    assert.equal(consolidateFanin({ angleResults }).verdict, "clean");
    assert.equal(
      consolidateFanin({
        angleResults,
        blockCleanOnFindingSeverities: ["high", "medium"],
      }).verdict,
      "findings_present",
    );
  });

  test("severity gating normalizes legacy blocking-list and finding spellings", () => {
    // Legacy-spelled blocking list against a canonical finding…
    assert.equal(
      consolidateFanin({
        angleResults: [findingAngle("kiss", "low")],
        blockCleanOnFindingSeverities: ["defer"],
      }).verdict,
      "findings_present",
    );
    // …and the mirror: canonical blocking list against a legacy finding.
    assert.equal(
      consolidateFanin({
        angleResults: [findingAngle("kiss", "defer")],
        blockCleanOnFindingSeverities: ["low"],
      }).verdict,
      "findings_present",
    );
    // Every pre-rename severity spelling still normalizes to its canonical
    // replacement and behaves identically.
    assert.equal(consolidateFanin({ angleResults: [findingAngle("kiss", "must-fix")] }).verdict, "findings_present");
    assert.equal(
      consolidateFanin({
        angleResults: [findingAngle("kiss", "worth-fixing-now")],
        blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
      }).verdict,
      "findings_present",
    );
    assert.equal(consolidateFanin({ angleResults: [findingAngle("kiss", "nice-to-have")] }).verdict, "clean");
  });

  test("a severity with incidental whitespace validates and blocks identically to its trimmed form", () => {
    // consolidate-fanin.mjs's own artifact-shape floor trims before validating
    // (see scripts/loop/consolidate-fanin.mjs's validateArtifactShape); this
    // pins that consolidateFanin itself is just as tolerant, so the two never
    // disagree on whether "high " is a valid, blocking severity.
    const result = consolidateFanin({ angleResults: [findingAngle("kiss", "high ")] });
    assert.equal(result.verdict, "findings_present");
    assert.equal(result.malformed.length, 0);
    assert.equal(result.findings[0].severity, "high");
  });

  test("question and nit are non-defect categories: never blocking under the default policy", () => {
    const result = consolidateFanin({
      angleResults: [findingAngle("scope", "question"), findingAngle("docs", "nit")],
    });
    assert.equal(result.verdict, "clean");
    assert.equal(result.counts.blocking, 0);
    assert.deepEqual(result.counts.bySeverity, { high: 0, medium: 0, low: 0, question: 1, nit: 1 });
    // A NON-LOCATABLE question (no file+line here) has no resolvable thread
    // to answer through — it is deferred by construction, exactly like nit
    // and every other non-blocking severity. See the sibling
    // "locatable question" test below for the needs-answer path.
    const question = result.findings.find((f) => f.severity === "question");
    const nit = result.findings.find((f) => f.severity === "nit");
    assert.equal(question.disposition, "deferred");
    assert.equal(nit.disposition, "deferred");
  });

  test("a LOCATABLE question (real file + positive-integer line) defaults to needs-answer, never deferred", () => {
    const result = consolidateFanin({
      angleResults: [findingAngle("scope", "question", "why this approach?", { file: "src/a.mjs", line: 12 })],
    });
    assert.equal(result.verdict, "clean");
    assert.equal(result.findings[0].disposition, "needs-answer");
    assert.equal(result.findings[0].file, "src/a.mjs");
    assert.equal(result.findings[0].line, 12);
  });

  test("blocked when any angle result is malformed/missing", () => {
    const cases = [
      [cleanAngle("scope"), null],
      [cleanAngle("scope"), { angle: "x", verdict: "bogus", findings: [] }],
      [{ angle: "x", verdict: "clean", findings: "nope" }],
      [{ verdict: "clean", findings: [] }], // missing angle
      [{ angle: "x", verdict: "findings_present", findings: [] }], // findings_present w/o findings
      [{ angle: "x", verdict: "clean", findings: [{ severity: "high", summary: "y" }] }], // clean w/ findings
      [{ angle: "x", verdict: "findings_present", findings: [{ severity: "nope", summary: "y" }] }],
      [{ angle: "x".repeat(201), verdict: "clean", findings: [] }], // pathologically long angle
    ];
    for (const angleResults of cases) {
      const result = consolidateFanin({ angleResults });
      assert.equal(result.verdict, "blocked", JSON.stringify(angleResults));
      assert.ok(result.malformed.length > 0);
      assert.equal(result.findings.length, 0);
    }
  });

  // Boundary fixture for MAX_ANGLE_NAME_LENGTH (200): pins the accept side so
  // the 201-char reject fixture above cannot be satisfied by silently
  // tightening the guard from `>` to `>=` (which would also reject a
  // legitimate 200-char name).
  test("an angle name at exactly the 200-char cap is accepted, not malformed", () => {
    const result = consolidateFanin({ angleResults: [cleanAngle("x".repeat(200))] });
    assert.equal(result.verdict, "clean");
    assert.equal(result.malformed.length, 0);
  });
});

describe("consolidateFanin — multi-angle merge", () => {
  test("flattens findings across angles with angle attribution + severity counts", () => {
    const result = consolidateFanin({
      angleResults: [
        {
          angle: "scope",
          verdict: "findings_present",
          findings: [
            { severity: "high", summary: "a", file: "src/a.mjs", line: 10, recommendation: "fix it" },
            { severity: "low", summary: "b" },
          ],
        },
        findingAngle("docs", "medium", "c"),
        cleanAngle("kiss"),
      ],
      blockCleanOnFindingSeverities: ["high", "medium"],
    });
    assert.equal(result.verdict, "findings_present");
    assert.equal(result.counts.angles, 3);
    assert.equal(result.counts.findings, 3);
    assert.equal(result.counts.blocking, 2);
    assert.deepEqual(result.counts.bySeverity, { high: 1, medium: 1, low: 1, question: 0, nit: 0 });
    const scopeFinding = result.findings.find((f) => f.angle === "scope" && f.severity === "high");
    assert.equal(scopeFinding.file, "src/a.mjs");
    assert.equal(scopeFinding.line, 10);
    assert.equal(scopeFinding.recommendation, "fix it");
    assert.equal(scopeFinding.disposition, "accepted-for-fix");
  });

  test("empty angle set is clean", () => {
    const result = consolidateFanin({ angleResults: [] });
    assert.equal(result.verdict, "clean");
    assert.equal(result.counts.angles, 0);
  });
});

describe("toFindingsLogShape", () => {
  test("maps consolidated findings into write-gate-findings-log --findings shape", () => {
    const consolidated = consolidateFanin({
      angleResults: [
        {
          angle: "scope",
          verdict: "findings_present",
          findings: [{ severity: "high", summary: "a", file: "src/a.mjs", recommendation: "x" }],
        },
        findingAngle("docs", "low", "b"),
      ],
    });
    const shaped = toFindingsLogShape(consolidated.findings);
    assert.deepEqual(shaped, [
      { severity: "high", angle: "scope", summary: "a", disposition: "accepted-for-fix", recommendation: "x", files: ["src/a.mjs"] },
      { severity: "low", angle: "docs", summary: "b", disposition: "deferred" },
    ]);
  });

  test("tolerates missing/empty input", () => {
    assert.deepEqual(toFindingsLogShape(undefined), []);
    assert.deepEqual(toFindingsLogShape([]), []);
  });

  test("carries a positive-integer line through", () => {
    const consolidated = consolidateFanin({
      angleResults: [
        {
          angle: "scope",
          verdict: "findings_present",
          findings: [{ severity: "high", summary: "a", file: "src/a.mjs", line: 42 }],
        },
      ],
    });
    const shaped = toFindingsLogShape(consolidated.findings);
    assert.deepEqual(shaped, [
      { severity: "high", angle: "scope", summary: "a", disposition: "accepted-for-fix", files: ["src/a.mjs"], line: 42 },
    ]);
  });

  test("drops a non-positive-integer or non-numeric line", () => {
    const shaped = toFindingsLogShape([
      { severity: "high", angle: "a", summary: "x", line: 0 },
      { severity: "high", angle: "a", summary: "y", line: -1 },
      { severity: "high", angle: "a", summary: "z", line: 1.5 },
      { severity: "high", angle: "a", summary: "w", line: "42" },
    ]);
    for (const entry of shaped) {
      assert.equal("line" in entry, false);
    }
  });
});

describe("planFanoutBatches", () => {
  test("no degradation when angles <= cap (single parallel batch)", () => {
    const angles = ["a", "b", "c"];
    const result = planFanoutBatches(angles, 8);
    assert.equal(result.degraded, false);
    assert.deepEqual(result.batches, [["a", "b", "c"]]);
  });

  test("exactly at the cap is a single batch (no degrade)", () => {
    const angles = Array.from({ length: 8 }, (_, i) => `a${i}`);
    const result = planFanoutBatches(angles, 8);
    assert.equal(result.degraded, false);
    assert.equal(result.batches.length, 1);
    assert.equal(result.batches[0].length, 8);
  });

  test("degrades into sequential batches when angles > cap", () => {
    const angles = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const result = planFanoutBatches(angles, 8);
    assert.equal(result.degraded, true);
    assert.equal(result.batches.length, 2);
    assert.equal(result.batches[0].length, 8);
    assert.equal(result.batches[1].length, 2);
    assert.deepEqual(result.batches.flat(), angles);
  });

  test("default cap is 8", () => {
    assert.equal(DEFAULT_MAX_FANOUT_REVIEWERS, 8);
    const angles = Array.from({ length: 9 }, (_, i) => `a${i}`);
    const result = planFanoutBatches(angles);
    assert.equal(result.degraded, true);
    assert.equal(result.batches.length, 2);
  });

  test("empty angle set yields no batches and no degradation", () => {
    assert.deepEqual(planFanoutBatches([]), { batches: [], degraded: false });
  });

  test("invalid cap falls back to default", () => {
    const angles = Array.from({ length: 9 }, (_, i) => `a${i}`);
    assert.equal(planFanoutBatches(angles, 0).batches.length, 2);
    assert.equal(planFanoutBatches(angles, -1).degraded, true);
  });
});

describe("fanoutUnavailableError / route-to-conductor contract (AC4)", () => {
  test("FANOUT_UNAVAILABLE_MESSAGE is the documented stable signal", () => {
    assert.equal(FANOUT_UNAVAILABLE_MESSAGE, "fan-out unavailable — route to conductor");
  });

  test("fanoutUnavailableError carries the route-to-conductor signal", () => {
    const err = fanoutUnavailableError();
    assert.ok(err instanceof Error);
    assert.equal(err.message, FANOUT_UNAVAILABLE_MESSAGE);
    assert.equal(err.routeToConductor, true);
    assert.equal(err.code, "FANOUT_UNAVAILABLE");
  });

  test("fanoutUnavailableError appends a diagnostic detail but keeps the matchable prefix", () => {
    const err = fanoutUnavailableError("subagent tool not honored at child depth");
    assert.ok(err.message.startsWith(FANOUT_UNAVAILABLE_MESSAGE));
    assert.ok(err.message.includes("subagent tool not honored"));
    assert.equal(err.routeToConductor, true);
  });
});

describe("provenance consistency (closes the self-produced loophole)", () => {
  test("countDistinctReviewers counts distinct reviewer/dispatchId identities only", () => {
    assert.equal(countDistinctReviewers([]), 0);
    assert.equal(countDistinctReviewers([{ angle: "a" }]), 0); // no identity
    assert.equal(countDistinctReviewers([{ angle: "a", reviewer: "x" }, { angle: "b", reviewer: "x" }]), 1); // dup
    assert.equal(countDistinctReviewers([{ angle: "a", reviewer: "x" }, { angle: "b", dispatchId: "y" }]), 2);
    assert.equal(countDistinctReviewers("nope"), 0);
  });

  test("provenanceConsistencyError accepts consistent provenance", () => {
    assert.equal(provenanceConsistencyError({ distinctReviewers: 0, perAngle: [] }), null);
    assert.equal(provenanceConsistencyError({ distinctReviewers: 2, perAngle: [{ angle: "a", reviewer: "x" }, { angle: "b", reviewer: "y" }] }), null);
  });

  test("provenanceConsistencyError rejects the {n, perAngle:[]} loophole and over-claims", () => {
    assert.match(provenanceConsistencyError(null), /must be an object/);
    assert.match(provenanceConsistencyError({ distinctReviewers: 1.5, perAngle: [] }), /non-negative integer/);
    assert.match(provenanceConsistencyError({ distinctReviewers: 2, perAngle: [] }), /perAngle must be non-empty/);
    assert.match(provenanceConsistencyError({ distinctReviewers: 2, perAngle: [{ angle: "a", reviewer: "x" }] }), /exceeds distinct recorded reviewer identities/);
  });
});

describe("countFreshDispatchUnits (AC7 — grouped-dispatch-aware provenance floor)", () => {
  test("identical to the distinct fresh-angle-name count when no entry declares a group", () => {
    const perAngle = [{ angle: "a" }, { angle: "b" }, { angle: "c" }];
    assert.equal(countFreshDispatchUnits(perAngle), freshAngleNames(perAngle).length);
    assert.equal(countFreshDispatchUnits(perAngle), 3);
  });

  test("a group of N fresh angles counts as ONE dispatch unit", () => {
    assert.equal(
      countFreshDispatchUnits([
        { angle: "a", group: "g1" }, { angle: "b", group: "g1" }, { angle: "c", group: "g1" },
      ]),
      1,
    );
  });

  test("10 fresh angles across 4 declared groups count as 4 dispatch units", () => {
    const perAngle = [
      { angle: "a", group: "g1" }, { angle: "b", group: "g1" }, { angle: "c", group: "g1" },
      { angle: "d", group: "g2" }, { angle: "e", group: "g2" },
      { angle: "f", group: "g3" }, { angle: "g", group: "g3" }, { angle: "h", group: "g3" },
      { angle: "i", group: "g4" }, { angle: "j", group: "g4" },
    ];
    assert.equal(freshAngleNames(perAngle).length, 10);
    assert.equal(countFreshDispatchUnits(perAngle), 4);
  });

  test("a mix of grouped and ungrouped fresh angles: groups + each ungrouped angle count separately", () => {
    assert.equal(
      countFreshDispatchUnits([
        { angle: "a", group: "g1" }, { angle: "b", group: "g1" },
        { angle: "c" }, { angle: "d" },
      ]),
      3, // g1, c, d
    );
  });

  test("carried angles are excluded, same as the fresh-angle-name count", () => {
    assert.equal(
      countFreshDispatchUnits([{ angle: "a", group: "g1" }, { angle: "b", group: "g1", carriedFromHead: "abc1234" }]),
      1,
    );
  });

  test("malformed input returns 0, same as the fresh-angle-name count", () => {
    assert.equal(countFreshDispatchUnits(null), 0);
    assert.equal(countFreshDispatchUnits("nope"), 0);
  });
});

describe("freshAngleNames", () => {
  test("returns distinct fresh angle names, excluding carried ones", () => {
    assert.deepEqual(
      freshAngleNames([{ angle: "a" }, { angle: "b" }, { angle: "a" }, { angle: "c", carriedFromHead: "abc1234" }]),
      ["a", "b"],
    );
    assert.deepEqual(freshAngleNames(null), []);
  });
});

describe("fanoutReviewerPairingError (#1431 — one scoped reviewer per fresh angle)", () => {
  test("accepts one distinct reviewer identity per fresh angle", () => {
    assert.equal(fanoutReviewerPairingError([]), null);
    assert.equal(fanoutReviewerPairingError([{ angle: "a", reviewer: "x" }]), null);
    assert.equal(
      fanoutReviewerPairingError([{ angle: "a", reviewer: "x" }, { angle: "b", reviewer: "y" }]),
      null,
    );
    assert.equal(fanoutReviewerPairingError(null), null);
    assert.equal(fanoutReviewerPairingError("nope"), null);
  });

  test("identity via dispatchId also satisfies the pairing floor", () => {
    assert.equal(
      fanoutReviewerPairingError([{ angle: "a", dispatchId: "d1" }, { angle: "b", dispatchId: "d2" }]),
      null,
    );
  });

  test("a dispatchId collision is labeled dispatchId in the error, not reviewer", () => {
    const error = fanoutReviewerPairingError([
      { angle: "a", dispatchId: "d1" },
      { angle: "b", dispatchId: "d1" },
    ]);
    assert.match(error, /dispatchId "d1" is recorded for fresh angles: a, b/);
    assert.doesNotMatch(error, /reviewer "d1"/);
  });

  test("detects one reviewer collapsing two fresh angles (collision)", () => {
    const error = fanoutReviewerPairingError([
      { angle: "a", reviewer: "x" },
      { angle: "b", reviewer: "x" },
    ]);
    assert.match(error, /one-scoped-reviewer-per-angle contract/);
    assert.match(error, /reviewer "x" is recorded for fresh angles: a, b/);
    assert.match(error, /inline_single_agent/);
  });

  test("a padded ledger (duplicate-angle entries) cannot mask a reviewer covering two fresh angles", () => {
    // 2 distinct identities >= 2 distinct angles would satisfy a cardinality
    // check, but reviewer "x" still covers both fresh angles.
    const error = fanoutReviewerPairingError([
      { angle: "a", reviewer: "x" },
      { angle: "b", reviewer: "x" },
      { angle: "a", reviewer: "y" },
    ]);
    assert.match(error, /reviewer "x" is recorded for fresh angles: a, b/);
  });

  test("detects a fresh angle recording no reviewer identity at all", () => {
    const error = fanoutReviewerPairingError([
      { angle: "a", reviewer: "x" },
      { angle: "b" },
    ]);
    assert.match(error, /fresh angle\(s\) with no recorded reviewer identity: b/);
  });

  test("a carried angle is EXEMPT — sharing its prior reviewer with a fresh angle is not a collision", () => {
    assert.equal(
      fanoutReviewerPairingError([
        { angle: "a", reviewer: "x" },
        { angle: "b", reviewer: "x", carriedFromHead: "abc1234" },
      ]),
      null,
    );
  });

  test("two carried angles sharing the same prior reviewer are both exempt", () => {
    assert.equal(
      fanoutReviewerPairingError([
        { angle: "a", reviewer: "x", carriedFromHead: "abc1234" },
        { angle: "b", reviewer: "x", carriedFromHead: "abc1234" },
      ]),
      null,
    );
  });

  test("grouped dispatch (AC7): two fresh angles sharing a reviewer under the SAME declared group are exempt", () => {
    assert.equal(
      fanoutReviewerPairingError([
        { angle: "a", reviewer: "x", group: "docs-surface" },
        { angle: "b", reviewer: "x", group: "docs-surface" },
      ]),
      null,
    );
  });

  test("grouped dispatch (AC7): two fresh angles sharing a reviewer under DIFFERENT declared groups still collide", () => {
    const error = fanoutReviewerPairingError([
      { angle: "a", reviewer: "x", group: "docs-surface" },
      { angle: "b", reviewer: "x", group: "process" },
    ]);
    assert.match(error, /reviewer "x" is recorded for fresh angles: a, b/);
  });

  test("grouped dispatch (AC7): one entry declaring a group and the other not still collides (missing group is its own value)", () => {
    const error = fanoutReviewerPairingError([
      { angle: "a", reviewer: "x", group: "docs-surface" },
      { angle: "b", reviewer: "x" },
    ]);
    assert.match(error, /reviewer "x" is recorded for fresh angles: a, b/);
  });

  describe("resolvedGroups cross-check (closes the self-attested-group loophole)", () => {
    const RESOLVED_GROUPS = [
      { name: "docs-surface", angles: ["a", "b"] },
      { name: "process", angles: ["c", "d"] },
      { name: "e", angles: ["e"] }, // ungrouped angle resolves to its own singleton
    ];

    test("without resolvedGroups (omitted), any single shared group label is accepted (today's permissive default)", () => {
      assert.equal(
        fanoutReviewerPairingError([
          { angle: "a", reviewer: "x", group: "anything" },
          { angle: "c", reviewer: "x", group: "anything" },
        ]),
        null,
      );
    });

    test("accepts a shared identity whose group is exactly a configured dispatch unit", () => {
      assert.equal(
        fanoutReviewerPairingError(
          [
            { angle: "a", reviewer: "x", group: "docs-surface" },
            { angle: "b", reviewer: "x", group: "docs-surface" },
          ],
          RESOLVED_GROUPS,
        ),
        null,
      );
    });

    test("rejects a fabricated group label spanning angles the configured table splits into DIFFERENT groups", () => {
      const error = fanoutReviewerPairingError(
        [
          { angle: "a", reviewer: "x", group: "everything" },
          { angle: "c", reviewer: "x", group: "everything" },
        ],
        RESOLVED_GROUPS,
      );
      assert.match(error, /does not place all of them in one group/);
    });

    test("rejects a fabricated group label spanning an angle the table never groups at all", () => {
      const error = fanoutReviewerPairingError(
        [
          { angle: "a", reviewer: "x", group: "everything" },
          { angle: "e", reviewer: "x", group: "everything" },
        ],
        RESOLVED_GROUPS,
      );
      assert.match(error, /does not place all of them in one group/);
    });

    // Issue 2180 (Path A) / ADR 0048: the emitter no longer splits a sanctioned
    // resolveFanoutGroups auto-chunk bundle into per-angle singletons — it
    // shares one reviewer for the whole bundle, same as a configured group.
    // Prove the merge guard remains the fail-closed authority for that
    // widened emitter behavior: a shared identity is honored ONLY when
    // resolveFanoutGroups itself placed every covered angle in the SAME
    // resolved unit — a fabricated group spanning angles the resolver split
    // into DIFFERENT auto-chunk bundles still fails closed, so removing the
    // emitter's singleton-split does not reopen the #2100/#2101 fail-open.
    test("(issue 2180 / ADR 0048) accepts a shared identity for a REAL resolveFanoutGroups auto-chunk bundle (positive)", async () => {
      const { resolveFanoutGroups } = await import("../src/config/config.mjs");
      // No configured groups; default maxAnglesPerGroup (3) auto-chunks
      // ["a", "b"] into ONE leftover bundle "group:a+b".
      const config = { version: 1 };
      const groups = resolveFanoutGroups(config, "preApproval", ["a", "b"]);
      assert.deepEqual(groups, [{ name: "group:a+b", angles: ["a", "b"] }]);
      const error = fanoutReviewerPairingError(
        [
          { angle: "a", reviewer: "x", group: "group:a+b" },
          { angle: "b", reviewer: "x", group: "group:a+b" },
        ],
        groups,
      );
      assert.equal(error, null);
    });

    test("(issue 2180 / ADR 0048) rejects a fabricated group label spanning angles resolveFanoutGroups auto-chunked into DIFFERENT leftover bundles (adversarial fail-closed)", async () => {
      const { resolveFanoutGroups } = await import("../src/config/config.mjs");
      // maxAnglesPerGroup: 1 forces every leftover angle into its OWN
      // single-angle bundle, so "a" and "b" resolve to DIFFERENT units.
      const config = { version: 1, gates: { fanout: { maxAnglesPerGroup: 1 } } };
      const groups = resolveFanoutGroups(config, "preApproval", ["a", "b"]);
      assert.deepEqual(groups, [{ name: "a", angles: ["a"] }, { name: "b", angles: ["b"] }]);
      const error = fanoutReviewerPairingError(
        [
          { angle: "a", reviewer: "x", group: "fabricated" },
          { angle: "b", reviewer: "x", group: "fabricated" },
        ],
        groups,
      );
      assert.match(error, /does not place all of them in one group/);
    });

    test("(issue 2180 / ADR 0048) rejects a shared group claim spanning an angle resolveFanoutGroups never resolved (maps to null) (adversarial fail-closed)", () => {
      const resolvedGroups = [{ name: "group:a+b", angles: ["a", "b"] }];
      const error = fanoutReviewerPairingError(
        [
          { angle: "a", reviewer: "x", group: "group:a+b" },
          { angle: "unresolved-angle", reviewer: "x", group: "group:a+b" },
        ],
        resolvedGroups,
      );
      assert.match(error, /does not place all of them in one group/);
    });

    test("per-angle mode (resolveFanoutGroups emits one singleton unit per angle) rejects ANY shared identity across units, regardless of the declared group label — gate:full no longer collapses to singletons (ADR 0048)", () => {
      const perAngleModeGroups = [
        { name: "a", angles: ["a"] },
        { name: "b", angles: ["b"] },
      ];
      const error = fanoutReviewerPairingError(
        [
          { angle: "a", reviewer: "x", group: "docs-surface" },
          { angle: "b", reviewer: "x", group: "docs-surface" },
        ],
        perAngleModeGroups,
      );
      assert.match(error, /does not place all of them in one group/);
    });
  });
});

describe("fanoutReviewerPairingError × the shipped preApproval grouping (light-track grouped provenance)", () => {
  async function shippedPreApprovalGroups() {
    const os = await import("node:os");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const path = await import("node:path");
    const { loadDevLoopConfig } = await import("../src/config/config.mjs");
    const { resolveFanoutGroups } = await import("../src/config/config.mjs");
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-gatefanin-preapproval-"));
    try {
      const { config } = await loadDevLoopConfig({ repoRoot: tmpDir });
      const angles = config.gates.preApproval.angles.map((a) => (typeof a === "string" ? a : a.name));
      return { config, angles, groups: resolveFanoutGroups(config, "preApproval", angles) };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  test("a light-track ledger recording one reviewer per resolved dispatch UNIT passes under the shipped grouped default", async () => {
    const { groups } = await shippedPreApprovalGroups();
    // One distinct reviewer per resolved group; every angle in a group shares
    // that group's reviewer + declared group name.
    const perAngle = groups.flatMap((g, i) =>
      g.angles.map((angle) => ({ angle, reviewer: `rev-${i}`, group: g.name })),
    );
    assert.equal(fanoutReviewerPairingError(perAngle, groups), null);
    // The design-quality set collapses: fewer fresh dispatch units than fresh angles.
    assert.ok(countFreshDispatchUnits(perAngle) < freshAngleNames(perAngle).length);
  });

  test("regression: one reviewer covering two angles the table places in DIFFERENT units still fails closed under the grouped default", async () => {
    const { groups } = await shippedPreApprovalGroups();
    const simplicity = groups.find((g) => g.name === "design-simplicity");
    const solid = groups.find((g) => g.name === "design-solid");
    // dry (design-simplicity) + srp (design-solid) are placed in different units.
    const error = fanoutReviewerPairingError(
      [
        { angle: simplicity.angles[0], reviewer: "x", group: "design-quality" },
        { angle: solid.angles[0], reviewer: "x", group: "design-quality" },
      ],
      groups,
    );
    assert.match(error, /does not place all of them in one group/);
  });
});

describe("checkFanoutAngleCoverage (#1196 — mandatory angles + angle-pool membership)", () => {
  test("passes when every mandatory angle is recorded and every angle is in the pool", () => {
    const result = checkFanoutAngleCoverage(
      [{ angle: "pr-checklist" }, { angle: "yagni" }],
      { mandatoryAngles: ["pr-checklist"], pool: ["yagni", "pr-checklist", "dry"] },
    );
    assert.deepEqual(result, { missingMandatory: [], foreignAngles: [] });
  });

  test("reports every mandatory angle absent from the recorded angles", () => {
    const result = checkFanoutAngleCoverage(
      [{ angle: "yagni" }],
      { mandatoryAngles: ["pr-checklist", "acceptance-criteria", "yagni"] },
    );
    assert.deepEqual(result.missingMandatory, ["pr-checklist", "acceptance-criteria"]);
  });

  test("reports recorded angles that are outside the configured pool (ad-hoc labels)", () => {
    const result = checkFanoutAngleCoverage(
      [{ angle: "dry" }, { angle: "made-up-angle" }],
      { mandatoryAngles: [], pool: ["dry", "kiss"] },
    );
    assert.deepEqual(result.foreignAngles, ["made-up-angle"]);
  });

  test("skips the foreign-angle check when no pool is supplied (null/absent)", () => {
    assert.deepEqual(
      checkFanoutAngleCoverage([{ angle: "anything" }], { mandatoryAngles: [] }),
      { missingMandatory: [], foreignAngles: [] },
    );
  });

  test("delta-suffixed angles (<angle>-delta-at-...) count toward their base angle for BOTH checks", () => {
    const result = checkFanoutAngleCoverage(
      [{ angle: "pr-checklist-delta-at-current-head" }],
      { mandatoryAngles: ["pr-checklist"], pool: ["pr-checklist"] },
    );
    assert.deepEqual(result, { missingMandatory: [], foreignAngles: [] });
  });

  test("tolerates malformed/missing input (non-array, entries without a usable .angle)", () => {
    assert.deepEqual(checkFanoutAngleCoverage(undefined, { mandatoryAngles: ["a"] }).missingMandatory, ["a"]);
    assert.deepEqual(checkFanoutAngleCoverage([null, { angle: "" }, "nope"], { mandatoryAngles: [] }).foreignAngles, []);
  });

  test("fan-in synthetic angle (pr-checklist) is never foreign, even when absent from the pool", () => {
    const result = checkFanoutAngleCoverage(
      [{ angle: "pr-checklist" }, { angle: "made-up-angle" }],
      { mandatoryAngles: [], pool: ["dry", "kiss"] },
    );
    assert.deepEqual(result.foreignAngles, ["made-up-angle"]);
  });

  test("delta-suffixed fan-in synthetic angle is never foreign when the pool omits its base", () => {
    const result = checkFanoutAngleCoverage(
      [{ angle: "pr-checklist-delta-at-current-head" }],
      { mandatoryAngles: [], pool: ["dry", "kiss"] },
    );
    assert.deepEqual(result.foreignAngles, []);
  });
});

describe("checkResolvedAngleEvidence (#1783 — fan-in catch for a resolved angle with neither an artifact nor a proven carry)", () => {
  test("refuses when a wrongly-carried NON-mandatory angle has neither an artifact nor a proven carry", () => {
    // "correctness" and "yagni" were both freshly reviewed (real artifacts); "dry" was the
    // round's resolved set too, but no artifact was written for it and it was never carried —
    // the exact under-dispatch shape checkFanoutAngleCoverage's own mandatory-only check misses
    // when "dry" is not a configured mandatory angle.
    const result = checkResolvedAngleEvidence(
      ["correctness", "yagni", "dry"],
      {
        recordedAngles: [{ angle: "correctness" }, { angle: "yagni" }],
        carriedAngles: [],
      },
    );
    assert.deepEqual(result.missingAngles, ["dry"]);
  });

  test("passes when every resolved angle has either a real artifact or a proven carry", () => {
    const result = checkResolvedAngleEvidence(
      ["correctness", "yagni", "dry"],
      {
        recordedAngles: [{ angle: "correctness" }, { angle: "yagni" }],
        carriedAngles: ["dry"],
      },
    );
    assert.deepEqual(result.missingAngles, []);
  });

  test("a grouped-but-ran angle (its own per-angle artifact, written by a shared-group reviewer) counts as covered", () => {
    // Grouped dispatch still writes one per-angle artifact per angle it covers (never one
    // merged artifact for the group) — so a grouped angle needs no special-casing here.
    const result = checkResolvedAngleEvidence(
      ["correctness", "dry", "kiss"],
      { recordedAngles: [{ angle: "correctness" }, { angle: "dry" }, { angle: "kiss" }], carriedAngles: [] },
    );
    assert.deepEqual(result.missingAngles, []);
  });

  test("delta-suffixed artifacts and carries count toward their base angle", () => {
    const result = checkResolvedAngleEvidence(
      ["correctness", "dry"],
      { recordedAngles: [{ angle: "correctness-delta-at-abc123" }], carriedAngles: ["dry"] },
    );
    assert.deepEqual(result.missingAngles, []);
  });

  test("matches case-insensitively — a resolved angle differing only in case from its artifact/carry is not falsely missing", () => {
    // Per-angle artifacts are independently authored, so a resolved "Dry" must still match a
    // recorded/carried "dry" — same base+lowercase rule consolidate-fanin.mjs applies to its own
    // angle keys (realAngleKeys/exemptCarriedKeys).
    const result = checkResolvedAngleEvidence(
      ["correctness", "Dry", "KISS"],
      { recordedAngles: [{ angle: "correctness" }, { angle: "dry" }], carriedAngles: ["kiss"] },
    );
    assert.deepEqual(result.missingAngles, []);
  });

  test("tolerates malformed/missing input (non-array resolvedAngles/recordedAngles, entries without a usable .angle)", () => {
    assert.deepEqual(checkResolvedAngleEvidence(undefined, {}).missingAngles, []);
    assert.deepEqual(
      checkResolvedAngleEvidence(["dry"], { recordedAngles: [null, { angle: "" }, "nope"] }).missingAngles,
      ["dry"],
    );
  });
});

describe("scheduleFanoutWaves (#1601 — bounded-concurrency wave plan via scheduleParallelWaves)", () => {
  const units = (names) => names.map((n) => ({ name: n, angles: [n] }));

  test("empty dispatch groups → no waves", () => {
    assert.deepEqual(scheduleFanoutWaves([], 4), []);
    assert.deepEqual(scheduleFanoutWaves(null, 4), []);
  });

  test("respects maxConcurrent: M units per wave", () => {
    const groups = units(["a", "b", "c", "d", "e", "f"]);
    const waves = scheduleFanoutWaves(groups, 2);
    assert.equal(waves.length, 3);
    assert.deepEqual(waves.map((w) => w.length), [2, 2, 2]);
    assert.deepEqual(waves[0].map((u) => u.name), ["a", "b"]);
    assert.deepEqual(waves[2].map((u) => u.name), ["e", "f"]);
  });

  test("default cap is 4", () => {
    const groups = units(["a", "b", "c", "d", "e"]);
    const waves = scheduleFanoutWaves(groups);
    assert.equal(waves.length, 2);
    assert.deepEqual(waves[0].map((u) => u.name), ["a", "b", "c", "d"]);
    assert.deepEqual(waves[1].map((u) => u.name), ["e"]);
  });

  test("cap 1 serializes heavy reviewers one at a time (#1726)", () => {
    const groups = units(["a", "b", "c", "d", "e"]);
    const waves = scheduleFanoutWaves(groups, 1);
    // every wave holds exactly one dispatch unit → 5 sequential waves.
    assert.equal(waves.length, 5);
    assert.ok(waves.every((w) => w.length === 1));
    assert.deepEqual(waves.map((w) => w[0].name), ["a", "b", "c", "d", "e"]);
  });

  test("a single unit / light round is one wave of one (not serialized)", () => {
    const waves = scheduleFanoutWaves(units(["a"]), 4);
    assert.deepEqual(waves, [[{ name: "a", angles: ["a"] }]]);
  });

  test("invalid maxConcurrent falls back to 4", () => {
    const groups = units(["a", "b", "c", "d", "e"]);
    assert.equal(scheduleFanoutWaves(groups, 0).length, 2);
    assert.equal(scheduleFanoutWaves(groups, -1).length, 2);
    assert.equal(scheduleFanoutWaves(groups, 1.5).length, 2);
  });

  test("deterministic: same input → same wave plan", () => {
    const groups = units(["a", "b", "c", "d"]);
    assert.deepEqual(scheduleFanoutWaves(groups, 3), scheduleFanoutWaves(groups, 3));
  });

  // AC1 wave-plan bound (#1971): under the Claude-clamped effective concurrency
  // (2), even a worst-case angle pool's wave plan never exceeds 2 dispatch
  // units per wave.
  test("wave-plan bound under the Claude-clamped effective concurrency (#1971)", () => {
    const groups = units(["a", "b", "c", "d", "e", "f", "g"]);
    const waves = scheduleFanoutWaves(groups, 2);
    assert.ok(waves.every((w) => w.length <= 2));
    assert.equal(waves.length, 4);
  });
});

describe("backoffMaxConcurrent (#1601 — adaptive 429 backoff)", () => {
  test("halves the active batch", () => {
    assert.equal(backoffMaxConcurrent(4), 2);
    assert.equal(backoffMaxConcurrent(8), 4);
    assert.equal(backoffMaxConcurrent(6), 3);
    assert.equal(backoffMaxConcurrent(3), 1);
  });
  test("never returns 0 — a backoff from 1 stays 1 (foreground fallback owns that path)", () => {
    assert.equal(backoffMaxConcurrent(1), 1);
    assert.equal(backoffMaxConcurrent(2), 1);
  });
  test("invalid input falls back to 4 then halves", () => {
    assert.equal(backoffMaxConcurrent(0), 2);
    assert.equal(backoffMaxConcurrent("4"), 2);
    assert.equal(backoffMaxConcurrent(-1), 2);
  });
  test("a backoff wave plan is tighter than the original", () => {
    const groups = [{ name: "a", angles: ["a"] }, { name: "b", angles: ["b"] }, { name: "c", angles: ["c"] }, { name: "d", angles: ["d"] }];
    const original = scheduleFanoutWaves(groups, 4);
    const backed = scheduleFanoutWaves(groups, backoffMaxConcurrent(4));
    assert.equal(original.length, 1); // one wave of 4
    assert.equal(backed.length, 2); // two waves of 2 after backoff
  });
});

describe("planDispatchRetry (#1971 — GATE-EXEC-DISPATCH-RETRY-BACKOFF as a pure, testable policy)", () => {
  test("transient 429: retries the same unit on the 30s/60s/120s schedule", () => {
    assert.deepEqual(planDispatchRetry(0, "429"), { retry: true, delayMs: 30000, reduceConcurrency: false });
    assert.deepEqual(planDispatchRetry(1, "429"), { retry: true, delayMs: 60000, reduceConcurrency: false });
    assert.deepEqual(planDispatchRetry(2, "429"), { retry: true, delayMs: 120000, reduceConcurrency: true });
  });

  test("transient 5xx is classified the same as 429", () => {
    assert.deepEqual(planDispatchRetry(0, "500"), { retry: true, delayMs: 30000, reduceConcurrency: false });
    assert.deepEqual(planDispatchRetry(1, "503"), { retry: true, delayMs: 60000, reduceConcurrency: false });
    assert.deepEqual(planDispatchRetry(2, "5xx"), { retry: true, delayMs: 120000, reduceConcurrency: true });
  });

  test("active batch reduces only after ~3 failed attempts on a unit, and the round is never aborted on a transient failure", () => {
    // Attempts 0 and 1 keep the full batch (reduceConcurrency: false); only the
    // 3rd exhausted attempt (index 2) signals the halve — the halving itself is
    // deferred to backoffMaxConcurrent, this policy only signals when to call it.
    assert.equal(planDispatchRetry(0, "429").reduceConcurrency, false);
    assert.equal(planDispatchRetry(1, "429").reduceConcurrency, false);
    assert.equal(planDispatchRetry(2, "429").reduceConcurrency, true);
    // Never a terminal abort on a transient failure — retry stays true throughout,
    // including beyond the 3rd attempt (the conductor keeps retrying at the
    // reduced batch, per GATE-EXEC-DISPATCH-RETRY-BACKOFF).
    for (const attempt of [0, 1, 2, 3, 10]) {
      const plan = planDispatchRetry(attempt, "429");
      assert.equal(plan.retry, true);
      assert.equal("escalate" in plan, false);
    }
  });

  test("a hard 4xx (e.g. 402) never retries into the same wall — escalates instead", () => {
    assert.deepEqual(planDispatchRetry(0, "402"), { retry: false, escalate: true });
    assert.deepEqual(planDispatchRetry(2, "404"), { retry: false, escalate: true });
  });
});

test("countFreshDispatchUnits counts auto-chunked groups as single units on a chunked round (#1601 AC7)", () => {
  // Simulate a round where resolveFanoutGroups auto-chunked 5 angles into 2
  // dispatch units (group:a+b+c, group:d+e) — each chunk is ONE dispatch unit,
  // so countFreshDispatchUnits must be 2, not 5.
  const perAngle = [
    { angle: "a", reviewer: "r1", group: "group:a+b+c" },
    { angle: "b", reviewer: "r1", group: "group:a+b+c" },
    { angle: "c", reviewer: "r1", group: "group:a+b+c" },
    { angle: "d", reviewer: "r2", group: "group:d+e" },
    { angle: "e", reviewer: "r2", group: "group:d+e" },
  ];
  assert.equal(countFreshDispatchUnits(perAngle), 2);
  assert.equal(countFreshDispatchUnits(perAngle) < freshAngleNames(perAngle).length, true);
  // A singleton leftover chunk named by its angle still counts as 1 unit.
  assert.equal(
    countFreshDispatchUnits([
      { angle: "a", reviewer: "r1", group: "group:a+b" },
      { angle: "b", reviewer: "r1", group: "group:a+b" },
      { angle: "c", reviewer: "r3" }, // leftover singleton, no group
    ]),
    2,
  );
});

describe("reviewerBudgetPreflight (#1507 — reviewer-budget preflight before fan-out dispatch)", () => {
  const units = (names) => names.map((n) => ({ name: n, angles: [n] }));

  test("counts one reviewer per dispatch unit (fresh angles + re-verifications)", () => {
    // 5 dispatch units → 5 required reviewers, regardless of how many angles
    // each unit covers (a group of N angles is one reviewer's scoped dispatch).
    const groups = [
      { name: "group:a+b", angles: ["a", "b"] },
      { name: "group:c+d", angles: ["c", "d"] },
      { name: "e", angles: ["e"] },
    ];
    const preflight = reviewerBudgetPreflight(groups, 10);
    assert.equal(preflight.requiredReviewers, 3);
    assert.equal(preflight.ok, true);
    assert.equal(preflight.dispatch, true);
    assert.equal(preflight.shortfall, null);
    assert.equal(preflight.reason, "budget_sufficient");
  });

  test("#1507 DoD1 — insufficient budget: dispatch is false and shortfall is named (zero reviewers dispatched)", () => {
    // The conductor reads `preflight.dispatch` before spawning any reviewer.
    // On `false` it records the shortfall and stops — NO reviewer is spawned.
    const groups = units(["a", "b", "c", "d", "e"]); // 5 required
    const preflight = reviewerBudgetPreflight(groups, 2); // only 2 available
    assert.equal(preflight.ok, false);
    assert.equal(preflight.dispatch, false);
    assert.equal(preflight.requiredReviewers, 5);
    assert.equal(preflight.availableReviewers, 2);
    assert.equal(preflight.shortfall, 3); // 5 - 2 = 3 short, named explicitly
    assert.equal(preflight.reason, "budget_shortfall");
  });

  test("#1507 DoD1 — exact budget covers dispatch (no shortfall)", () => {
    const groups = units(["a", "b", "c"]);
    assert.equal(reviewerBudgetPreflight(groups, 3).dispatch, true);
    assert.equal(reviewerBudgetPreflight(groups, 3).shortfall, null);
  });

  test("#1507 DoD1 — zero budget against a non-empty round is a shortfall", () => {
    const groups = units(["a", "b"]);
    const preflight = reviewerBudgetPreflight(groups, 0);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.dispatch, false);
    assert.equal(preflight.shortfall, 2);
  });

  test("unknown budget (harness does not expose one) proceeds — no shortfall can be proven", () => {
    const groups = units(["a", "b", "c"]);
    const preflight = reviewerBudgetPreflight(groups, null);
    assert.equal(preflight.ok, true);
    assert.equal(preflight.dispatch, true);
    assert.equal(preflight.availableReviewers, null);
    assert.equal(preflight.shortfall, null);
    assert.equal(preflight.reason, "budget_unknown");
    // Non-finite values are treated as unknown too (caller bug, not a shortfall).
    assert.equal(reviewerBudgetPreflight(groups, NaN).dispatch, true);
    assert.equal(reviewerBudgetPreflight(groups, undefined).dispatch, true);
  });

  test("empty dispatch plan needs no reviewers", () => {
    const preflight = reviewerBudgetPreflight([], 0);
    assert.equal(preflight.ok, true);
    assert.equal(preflight.dispatch, true);
    assert.equal(preflight.requiredReviewers, 0);
    assert.equal(preflight.shortfall, null);
    assert.equal(preflight.reason, "no_reviewers_needed");
    // Non-array input is defensive (no groups → nothing to dispatch).
    assert.equal(reviewerBudgetPreflight(null, 5).requiredReviewers, 0);
  });

  test("negative/fractional budget clamps to a non-negative integer floor", () => {
    const groups = units(["a", "b", "c"]);
    // negative → 0 → shortfall
    assert.equal(reviewerBudgetPreflight(groups, -5).availableReviewers, 0);
    assert.equal(reviewerBudgetPreflight(groups, -5).dispatch, false);
    assert.equal(reviewerBudgetPreflight(groups, -5).shortfall, 3);
    // fractional → truncates toward zero (2.9 → 2 → shortfall of 1)
    assert.equal(reviewerBudgetPreflight(groups, 2.9).availableReviewers, 2);
    assert.equal(reviewerBudgetPreflight(groups, 2.9).shortfall, 1);
  });

  test("#1507 DoD2 — a shortfall does NOT yield a clean or inline verdict for a non-light-mode PR", () => {
    // A shortfall is not a verdict: the preflight result carries no clean
    // verdict and no inline executionMode. buildPreMergeGateCheck /
    // evaluateInlineFanoutMode reject a gate with no clean current-head
    // marker and a non-fanout_fanin executionMode, so a shortfall state fails
    // closed at merge instead of yielding a clean or inline verdict (#1507 AC4:
    // no new gate-exemption path).
    const groups = units(["a", "b", "c", "d", "e"]);
    const preflight = reviewerBudgetPreflight(groups, 1);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.dispatch, false);
    assert.notEqual(preflight.verdict, "clean");
    assert.notEqual(preflight.executionMode, "inline_single_agent");
    assert.equal(preflight.verdict, null);
    assert.equal(preflight.executionMode, null);
    // A sufficient budget also never claims a verdict — the preflight is a
    // pre-dispatch gate, not a verdict producer.
    const ok = reviewerBudgetPreflight(groups, 10);
    assert.equal(ok.verdict, null);
    assert.equal(ok.executionMode, null);
  });

  describe("#1507 AC3 — same-head skip-completed resume (resumes instead of restarts)", () => {
    const units = (names) => names.map((n) => ({ name: n, angles: [n] }));

    test("a group whose angles are ALL complete is excluded from requiredReviewers and pendingGroups", () => {
      // 3 dispatch units; group:b already has a clean artifact at this head.
      const groups = units(["a", "b", "c"]);
      const preflight = reviewerBudgetPreflight(groups, 10, { completedAngles: ["b"] });
      assert.equal(preflight.requiredReviewers, 2); // only a + c remain
      assert.deepEqual(
        preflight.pendingGroups.map((g) => g.name),
        ["a", "c"],
      );
      assert.deepEqual(
        preflight.skippedGroups.map((g) => g.name),
        ["b"],
      );
      assert.deepEqual(preflight.completedAngles, ["b"]);
      assert.equal(preflight.dispatch, true);
      assert.equal(preflight.shortfall, null);
    });

    test("a multi-angle group is skipped only when EVERY angle is complete", () => {
      // group:a+b is NOT skipped when only one of its angles is complete — the
      // reviewer still needs to run for the incomplete angle.
      const groups = [{ name: "group:a+b", angles: ["a", "b"] }, { name: "c", angles: ["c"] }];
      const partial = reviewerBudgetPreflight(groups, 10, { completedAngles: ["a"] });
      assert.equal(partial.requiredReviewers, 2); // group:a+b still needs a reviewer (b incomplete) + c
      assert.deepEqual(partial.pendingGroups.map((g) => g.name), ["group:a+b", "c"]);
      assert.deepEqual(partial.skippedGroups, []);
      const full = reviewerBudgetPreflight(groups, 10, { completedAngles: ["a", "b"] });
      assert.equal(full.requiredReviewers, 1); // only c remains
      assert.deepEqual(full.pendingGroups.map((g) => g.name), ["c"]);
      assert.deepEqual(full.skippedGroups.map((g) => g.name), ["group:a+b"]);
    });

    test("all groups complete at this head → zero reviewers, resume finished, still no clean/inline verdict", () => {
      const groups = units(["a", "b"]);
      const preflight = reviewerBudgetPreflight(groups, 0, { completedAngles: ["a", "b"] });
      assert.equal(preflight.requiredReviewers, 0);
      assert.equal(preflight.dispatch, true); // proceed to fan-in of existing artifacts
      assert.equal(preflight.shortfall, null);
      assert.equal(preflight.reason, "no_reviewers_needed");
      assert.deepEqual(preflight.pendingGroups, []);
      assert.deepEqual(preflight.skippedGroups.map((g) => g.name), ["a", "b"]);
      // AC4 still holds: a resume-finished state is not a verdict.
      assert.equal(preflight.verdict, null);
      assert.equal(preflight.executionMode, null);
    });

    test("shortfall is computed against the REMAINING (incomplete) groups, not the full plan", () => {
      // 5 units; 2 already complete → only 3 remain. A budget of 1 is short by 2,
      // not by 4 — the later session resumes by dispatching only the 3 pending.
      const groups = units(["a", "b", "c", "d", "e"]);
      const preflight = reviewerBudgetPreflight(groups, 1, { completedAngles: ["a", "b"] });
      assert.equal(preflight.dispatch, false);
      assert.equal(preflight.requiredReviewers, 3);
      assert.equal(preflight.shortfall, 2);
      assert.equal(preflight.reason, "budget_shortfall");
      assert.deepEqual(preflight.pendingGroups.map((g) => g.name), ["c", "d", "e"]);
    });

    test("omitting completedAngles is backward-compatible (full dispatch, nothing skipped)", () => {
      const groups = units(["a", "b"]);
      assert.equal(reviewerBudgetPreflight(groups, 10).requiredReviewers, 2);
      assert.equal(reviewerBudgetPreflight(groups, 10, {}).requiredReviewers, 2);
      assert.deepEqual(reviewerBudgetPreflight(groups, 10).skippedGroups, []);
    });
  });

  describe("#1635 — head-bump carry-forward resume (carriedAngles alongside completedAngles)", () => {
    const units = (names) => names.map((n) => ({ name: n, angles: [n] }));

    test("a group whose angles are ALL carried forward is excluded from requiredReviewers and pendingGroups", () => {
      // 3 dispatch units; group:b was proven carried forward by Phase 1.2
      // (resolve-angle-carry-forward.mjs) from a prior clean head — no
      // same-head artifact exists for it yet, so completedAngles alone would
      // not have excluded it.
      const groups = units(["a", "b", "c"]);
      const preflight = reviewerBudgetPreflight(groups, 10, { carriedAngles: ["b"] });
      assert.equal(preflight.requiredReviewers, 2); // only a + c remain
      assert.deepEqual(preflight.pendingGroups.map((g) => g.name), ["a", "c"]);
      assert.deepEqual(preflight.skippedGroups.map((g) => g.name), ["b"]);
      assert.deepEqual(preflight.carriedAngles, ["b"]);
      assert.equal(preflight.dispatch, true);
      assert.equal(preflight.shortfall, null);
    });

    test("a shortfall on a head-bump re-gate is computed over the groups NEITHER completed NOR carried", () => {
      // 5 units; "a" has a same-head clean artifact, "b" is carried forward —
      // only c, d, e remain. A budget of 1 is short by 2, matching the plain
      // completedAngles-only shortfall test above, proving carriedAngles
      // narrows the count the same way completedAngles does.
      const groups = units(["a", "b", "c", "d", "e"]);
      const preflight = reviewerBudgetPreflight(groups, 1, {
        completedAngles: ["a"],
        carriedAngles: ["b"],
      });
      assert.equal(preflight.dispatch, false);
      assert.equal(preflight.requiredReviewers, 3);
      assert.equal(preflight.shortfall, 2);
      assert.equal(preflight.reason, "budget_shortfall");
      assert.deepEqual(preflight.pendingGroups.map((g) => g.name), ["c", "d", "e"]);
      assert.deepEqual(preflight.skippedGroups.map((g) => g.name), ["a", "b"]);
    });

    test("a multi-angle group is skipped only when every angle is completed-or-carried, mixing both sources", () => {
      const groups = [{ name: "group:a+b", angles: ["a", "b"] }, { name: "c", angles: ["c"] }];
      const partial = reviewerBudgetPreflight(groups, 10, { completedAngles: ["a"], carriedAngles: ["c"] });
      assert.equal(partial.requiredReviewers, 1); // group:a+b still needs b; c is fully resolved
      assert.deepEqual(partial.pendingGroups.map((g) => g.name), ["group:a+b"]);
      assert.deepEqual(partial.skippedGroups.map((g) => g.name), ["c"]);
      const full = reviewerBudgetPreflight(groups, 10, { completedAngles: ["a"], carriedAngles: ["b", "c"] });
      assert.equal(full.requiredReviewers, 0);
      assert.deepEqual(full.skippedGroups.map((g) => g.name), ["group:a+b", "c"]);
    });

    test("omitting carriedAngles is backward-compatible (full count, #1507 completedAngles-only behavior unchanged)", () => {
      const groups = units(["a", "b"]);
      assert.equal(reviewerBudgetPreflight(groups, 10, { completedAngles: ["a"] }).requiredReviewers, 1);
      assert.equal(reviewerBudgetPreflight(groups, 10, { completedAngles: ["a"], carriedAngles: undefined }).requiredReviewers, 1);
      assert.deepEqual(reviewerBudgetPreflight(groups, 10).carriedAngles, []);
    });

    test("group/carried-angle membership matches trim+lowercase (mirrors consolidate-fanin.mjs's own carried-key normalization)", () => {
      // The group's angle name carries case drift ("Correctness") relative to
      // the carried/completed name the caller supplies — both seams must still
      // agree this group is resolved, or one seam honors the carried name
      // while the other silently spends a reviewer on it.
      const groups = [{ name: "group:Correctness", angles: ["Correctness"] }, { name: "b", angles: ["b"] }];
      const viaCarried = reviewerBudgetPreflight(groups, 10, { carriedAngles: [" correctness "] });
      assert.equal(viaCarried.requiredReviewers, 1);
      assert.deepEqual(viaCarried.skippedGroups.map((g) => g.name), ["group:Correctness"]);
      const viaCompleted = reviewerBudgetPreflight(groups, 10, { completedAngles: ["CORRECTNESS"] });
      assert.equal(viaCompleted.requiredReviewers, 1);
      assert.deepEqual(viaCompleted.skippedGroups.map((g) => g.name), ["group:Correctness"]);
      // The recorded resume fields still echo the caller's input verbatim —
      // normalization is for membership matching only, never a silent rewrite
      // of the returned provenance.
      assert.deepEqual(viaCarried.carriedAngles, [" correctness "]);
    });
  });
});

// #1525: the judge agent's relevance-based dispositions (act/defer/reject) are
// a separate axis from the severity-based disposition deriveDisposition owns.
// applyJudgeDispositions is the pure merge seam that enriches the consolidated
// findings with the judge's verdict so the ledger and posted comment carry what
// was consciously not acted on and why.
describe("applyJudgeDispositions (#1525)", () => {
  const baseFindings = [
    { severity: "high", angle: "correctness", summary: "null deref in parser", disposition: "accepted-for-fix", file: "src/parser.mjs", line: 42 },
    { severity: "low", angle: "docs", summary: "rename variable for clarity", disposition: "deferred" },
  ];

  function judgeVerdict(dispositions, scopeDrift = { verdict: "within_scope", rationale: "diff matches the stated AC", driftedAreas: [] }) {
    return { headSha: "abc123", scopeDrift, dispositions };
  }

  test("a finding acted on against a named criterion gets judgeDisposition act", () => {
    const verdict = judgeVerdict([
      { index: 0, disposition: "act", rationale: "fixes the null-deref named in AC criterion 1", criterion: "AC-1: parser must not crash on null input" },
      { index: 1, disposition: "reject", rationale: "style-only rename, out of scope", criterion: "Non-goal 3" },
    ]);
    const { findings, scopeDrift } = applyJudgeDispositions(baseFindings, verdict);
    assert.equal(findings[0].judgeDisposition, "act");
    assert.equal(findings[0].judgeRationale, "fixes the null-deref named in AC criterion 1");
    assert.equal(findings[0].judgeCriterion, "AC-1: parser must not crash on null input");
    // severity-based disposition stays intact (complementary, not replaced)
    assert.equal(findings[0].disposition, "accepted-for-fix");
    assert.equal(scopeDrift.verdict, "within_scope");
  });

  test("a finding rejected as out-of-scope against a named non-goal gets judgeDisposition reject", () => {
    const verdict = judgeVerdict([
      { index: 0, disposition: "act", rationale: "in-scope defect", criterion: "AC-1" },
      { index: 1, disposition: "reject", rationale: "variable rename is a style preference; non-goal 3 excludes style churn from this PR", criterion: "Non-goal 3: no stylistic refactors" },
    ]);
    const { findings } = applyJudgeDispositions(baseFindings, verdict);
    assert.equal(findings[1].judgeDisposition, "reject");
    assert.equal(findings[1].judgeRationale, "variable rename is a style preference; non-goal 3 excludes style churn from this PR");
    assert.equal(findings[1].judgeCriterion, "Non-goal 3: no stylistic refactors");
    // no followUpDraft on a reject (reject is out-of-scope, not deferred work)
    assert.equal(findings[1].followUpDraft, undefined);
  });

  test("a deferred finding carries a fileable follow-up draft (soft-cap contract)", () => {
    const verdict = judgeVerdict([
      { index: 0, disposition: "act", rationale: "in-scope", criterion: "AC-1" },
      { index: 1, disposition: "defer", rationale: "valid improvement but outside this PR's scope; track separately", criterion: "Non-goal 2: no broad refactor", followUpDraft: { title: "Rename parser variable for clarity", body: "## Summary\nRename the variable per the reviewer suggestion." } },
    ]);
    const { findings } = applyJudgeDispositions(baseFindings, verdict);
    assert.equal(findings[1].judgeDisposition, "defer");
    assert.deepEqual(findings[1].followUpDraft, { title: "Rename parser variable for clarity", body: "## Summary\nRename the variable per the reviewer suggestion." });
  });

  test("scope-drift verdict is raised when the diff exceeds the declared scope", () => {
    const verdict = judgeVerdict(
      [
        { index: 0, disposition: "act", rationale: "in-scope", criterion: "AC-1" },
        { index: 1, disposition: "reject", rationale: "style-only rename, out of scope", criterion: "Non-goal 3" },
      ],
      { verdict: "drift_detected", rationale: "the diff adds a new CLI flag not in any acceptance criterion; criterion 4 limits scope to the parser", driftedAreas: ["cli surface"] },
    );
    const { scopeDrift } = applyJudgeDispositions(baseFindings, verdict);
    assert.equal(scopeDrift.verdict, "drift_detected");
    assert.equal(scopeDrift.driftedAreas[0], "cli surface");
  });

  test("scopeDrift.verdict 'none' normalizes to within_scope, rationale and driftedAreas byte-intact (#2260)", () => {
    const verdict = judgeVerdict(
      [
        { index: 0, disposition: "act", rationale: "in-scope", criterion: "AC-1" },
        { index: 1, disposition: "reject", rationale: "style-only rename, out of scope", criterion: "Non-goal 3" },
      ],
      { verdict: "none", rationale: "no drift; the diff matches the stated AC exactly", driftedAreas: [] },
    );
    const { scopeDrift } = applyJudgeDispositions(baseFindings, verdict);
    assert.equal(scopeDrift.verdict, "within_scope");
    assert.equal(scopeDrift.rationale, "no drift; the diff matches the stated AC exactly");
    assert.deepEqual(scopeDrift.driftedAreas, []);
  });

  test("normalizeScopeDriftVerdict maps none -> within_scope and passes canonical/unknown through", () => {
    assert.equal(normalizeScopeDriftVerdict("none"), "within_scope");
    assert.equal(normalizeScopeDriftVerdict("within_scope"), "within_scope");
    assert.equal(normalizeScopeDriftVerdict("drift_detected"), "drift_detected");
    assert.equal(normalizeScopeDriftVerdict("bogus"), "bogus");
  });

  test("normalizeScopeDriftVerdict only normalizes a primitive string (non-string fails closed, no alias coercion)", () => {
    // hasOwnProperty.call coerces its key, so a boxed String or an object whose
    // toString() is "none" must NOT alias to within_scope — the guard keeps
    // non-string verdicts on the passthrough path so the validator rejects them.
    const boxed = new String("none"); // eslint-disable-line no-new-wrappers
    assert.notEqual(normalizeScopeDriftVerdict(boxed), "within_scope");
    assert.equal(normalizeScopeDriftVerdict(boxed), boxed);
    const coercer = { toString: () => "none" };
    assert.equal(normalizeScopeDriftVerdict(coercer), coercer);
    assert.equal(normalizeScopeDriftVerdict(42), 42);
    assert.equal(normalizeScopeDriftVerdict(null), null);
  });

  test("validateJudgeVerdict fails closed on a non-string scopeDrift.verdict that coerces to an alias key", () => {
    const boxed = new String("none"); // eslint-disable-line no-new-wrappers
    assert.throws(
      () => validateJudgeVerdict(judgeVerdict([{ index: 0, disposition: "act", rationale: "x", criterion: "AC-1" }, { index: 1, disposition: "reject", rationale: "y", criterion: "NG-3" }], { verdict: boxed, rationale: "x", driftedAreas: [] })),
      /scopeDrift\.verdict must be one of: within_scope, drift_detected/,
    );
    assert.throws(
      () => validateJudgeVerdict(judgeVerdict([{ index: 0, disposition: "act", rationale: "x", criterion: "AC-1" }, { index: 1, disposition: "reject", rationale: "y", criterion: "NG-3" }], { verdict: { toString: () => "none" }, rationale: "x", driftedAreas: [] })),
      /scopeDrift\.verdict must be one of: within_scope, drift_detected/,
    );
  });

  test("validateJudgeVerdict still fails closed on a scopeDrift.verdict outside the vocabulary", () => {
    assert.throws(
      () => validateJudgeVerdict(judgeVerdict([{ index: 0, disposition: "act", rationale: "x", criterion: "AC-1" }, { index: 1, disposition: "reject", rationale: "y", criterion: "NG-3" }], { verdict: "sideways", rationale: "x", driftedAreas: [] })),
      /scopeDrift\.verdict must be one of: within_scope, drift_detected/,
    );
  });

  // Every doc surface that spells the scopeDrift.verdict vocabulary in a
  // schema line is bound to the validator's accepted set, so a producer-facing
  // description and the enforcer cannot silently diverge again (#2260).
  for (const rel of ["../../../agents/judge.agent.md", "../../../skills/docs/gate-review-sub-loop-contract.md"]) {
    test(`scopeDrift.verdict vocabulary in ${rel.replace("../../../", "")} equals the validator's accepted set (divergence guard, #2260)`, async () => {
      const { readFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const path = await import("node:path");
      const docPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel);
      const doc = readFileSync(docPath, "utf8");
      // Capture only the scopeDrift.verdict VALUE expression — a run of quoted
      // tokens optionally pipe-joined — so surrounding schema keys never leak in.
      const block = doc.match(/"scopeDrift"\s*:\s*\{[\s\S]*?"verdict"\s*:\s*((?:"[^"]*"\s*\|?\s*)+)/);
      assert.ok(block, `${rel} must document a scopeDrift.verdict schema line`);
      // Tolerate both spellings: two quoted tokens ("a" | "b") and one pipe-joined
      // string ("a|b").
      const documented = [...block[1].matchAll(/[a-z_]+/g)].map((m) => m[0]);
      assert.deepEqual(
        [...new Set(documented)].sort(),
        [...SCOPE_DRIFT_VERDICTS].sort(),
        `${rel} scopeDrift.verdict values must equal the validator's accepted set`,
      );
    });
  }

  test("toFindingsLogShape carries judge fields through to the ledger shape", () => {
    const verdict = judgeVerdict([
      { index: 0, disposition: "act", rationale: "in-scope", criterion: "AC-1" },
      { index: 1, disposition: "defer", rationale: "deferred", criterion: "NG-2", followUpDraft: { title: "x", body: "y" } },
    ]);
    const { findings } = applyJudgeDispositions(baseFindings, verdict);
    const logShape = toFindingsLogShape(findings);
    assert.equal(logShape[0].judgeDisposition, "act");
    assert.equal(logShape[0].judgeRationale, "in-scope");
    assert.equal(logShape[1].followUpDraft.title, "x");
  });

  test("fails closed on an out-of-range disposition index", () => {
    const verdict = judgeVerdict([
      { index: 5, disposition: "act", rationale: "x", criterion: "AC-1" },
    ]);
    assert.throws(() => applyJudgeDispositions(baseFindings, verdict), /out of range/);
  });

  test("fails closed on a malformed judge verdict (missing headSha)", () => {
    assert.throws(() => applyJudgeDispositions(baseFindings, { scopeDrift: { verdict: "within_scope", rationale: "x", driftedAreas: [] }, dispositions: [] }), /headSha/);
  });

  test("fails closed when a defer disposition lacks a followUpDraft", () => {
    const verdict = judgeVerdict([
      { index: 0, disposition: "defer", rationale: "deferred", criterion: "NG-2" },
    ]);
    assert.throws(() => applyJudgeDispositions(baseFindings, verdict), /followUpDraft.*defer/);
  });

  test("fails closed on a duplicate disposition index (one-per-finding contract)", () => {
    const verdict = judgeVerdict([
      { index: 0, disposition: "act", rationale: "in-scope", criterion: "AC-1" },
      { index: 0, disposition: "reject", rationale: "dup", criterion: "NG-2" },
    ]);
    assert.throws(() => applyJudgeDispositions(baseFindings, verdict), /duplicate.*one disposition per finding/);
  });

  test("fails closed on a non-string driftedAreas element", () => {
    const verdict = judgeVerdict(
      [{ index: 0, disposition: "act", rationale: "in-scope", criterion: "AC-1" }],
      { verdict: "drift_detected", rationale: "x", driftedAreas: [42] },
    );
    assert.throws(() => applyJudgeDispositions(baseFindings, verdict), /driftedAreas.*non-empty string/);
  });

  test("no judge verdict enrichment leaves findings unchanged (toFindingsLogShape is additive)", () => {
    const logShape = toFindingsLogShape(baseFindings);
    assert.equal(logShape[0].judgeDisposition, undefined);
    assert.equal(logShape[0].followUpDraft, undefined);
  });

  test("fails closed when a disposition leaves a finding uncovered, naming its 0-based array position", () => {
    const verdict = judgeVerdict([
      { index: 0, disposition: "act", rationale: "in-scope", criterion: "AC-1" },
    ]);
    assert.throws(
      () => applyJudgeDispositions(baseFindings, verdict),
      /does not dispose 1 finding\(s\) \(indexes: 1\)/,
    );
  });

  test("fails closed when a disposition leaves two findings uncovered, listing both positions", () => {
    const verdict = judgeVerdict([]);
    assert.throws(
      () => applyJudgeDispositions(baseFindings, verdict),
      /does not dispose 2 finding\(s\) \(indexes: 0, 1\)/,
    );
  });

  test("fails closed on a pre-enriched ledger when the current verdict disposes nothing (coverage is judged against THIS verdict, not field presence)", () => {
    const alreadyEnriched = baseFindings.map((f) => ({ ...f, judgeDisposition: "act", judgeRationale: "prior round" }));
    const verdict = judgeVerdict([]);
    assert.throws(
      () => applyJudgeDispositions(alreadyEnriched, verdict),
      /does not dispose 2 finding\(s\) \(indexes: 0, 1\)/,
    );
  });

  test("re-disposing a pre-enriched defer-with-draft finding to act drops the stale followUpDraft", () => {
    const alreadyEnriched = baseFindings.map((f, i) => (i === 1
      ? { ...f, judgeDisposition: "defer", judgeRationale: "prior round", judgeCriterion: "NG-2", followUpDraft: { title: "stale", body: "stale body" } }
      : { ...f }));
    const verdict = judgeVerdict([
      { index: 0, disposition: "act", rationale: "in-scope", criterion: "AC-1" },
      { index: 1, disposition: "act", rationale: "now in-scope, no longer deferred", criterion: "AC-2" },
    ]);
    const { findings } = applyJudgeDispositions(alreadyEnriched, verdict);
    assert.equal(findings[1].judgeDisposition, "act");
    assert.equal(findings[1].followUpDraft, undefined);
  });

  test("an empty findings array with an empty dispositions array is vacuously covered", () => {
    const verdict = judgeVerdict([]);
    const { findings } = applyJudgeDispositions([], verdict);
    assert.deepEqual(findings, []);
  });
});

describe("consolidateFanin + finding-cluster (issue 2156 — fan-in clustering / clean-implies-no-act / deduped act list)", () => {
  const HEAD = "deadbeef01";

  // Two angles independently reporting the SAME root cause (identical
  // file:line + recommendation) at the round's head.
  const angleResults = [
    {
      angle: "correctness",
      verdict: "findings_present",
      headSha: HEAD,
      findings: [{ severity: "must-fix", summary: "null deref", file: "src/x.mjs", line: 10, recommendation: "add a null guard" }],
    },
    {
      angle: "security",
      verdict: "findings_present",
      headSha: HEAD,
      findings: [{ severity: "must-fix", summary: "same null deref, different angle", file: "src/x.mjs", line: 10, recommendation: "add a null guard" }],
    },
    {
      angle: "performance",
      verdict: "findings_present",
      headSha: HEAD,
      findings: [{ severity: "must-fix", summary: "unrelated defect", file: "src/y.mjs", line: 1, recommendation: "cache the result" }],
    },
  ];

  test("mixed act/defer/reject: clusterFindings groups the duplicate root cause and leaves the distinct one separate", () => {
    const { findings } = consolidateFanin({ angleResults });
    const { ok, clusters } = clusterFindings(findings, { headSha: HEAD });
    assert.equal(ok, true);
    assert.equal(clusters.length, 2, "3 findings, 2 distinct root causes");
    assert.deepEqual(clusters[0].memberIndices, [0, 1]);
    assert.deepEqual(clusters[1].memberIndices, [2]);
  });

  test("dedupeActListByCluster yields the EXACT deduped fixer act list — one remediation per acted cluster", () => {
    const { findings } = consolidateFanin({ angleResults });
    const { clusters } = clusterFindings(findings, { headSha: HEAD });
    // Every finding acted on (mixed act/defer/reject in a larger round is
    // exercised in judge-pass.test.mjs's own wiring test; this asserts the
    // pure dedup contract in isolation against a real consolidateFanin shape).
    const act = findings; // all 3 are "high"-blocking, i.e. accepted-for-fix
    const deduped = dedupeActListByCluster(act, clusters, findings);
    assert.equal(act.length, 3);
    assert.equal(deduped.length, 2, "the duplicate root cause collapses to its representative");
    assert.deepEqual(deduped, [findings[0], findings[2]]);
  });

  test("assertCleanImpliesNoBlockingAct rejects a clean verdict with an act on a blocking severity", () => {
    assert.throws(
      () => assertCleanImpliesNoBlockingAct("clean", [{ severity: "high" }], ["high"]),
      /clean verdict is invalid/,
    );
  });

  test("assertCleanImpliesNoBlockingAct accepts a clean verdict with acts only on non-blocking severities", () => {
    assert.equal(assertCleanImpliesNoBlockingAct("clean", [{ severity: "medium" }, { severity: "low" }], ["high"]), "clean");
    assert.equal(assertCleanImpliesNoBlockingAct("clean", [], ["high"]), "clean");
    assert.equal(assertCleanImpliesNoBlockingAct("findings_present", [{ severity: "high" }], ["high"]), "findings_present");
  });
});

describe("resolveFindingFile (#1900): one shared file resolver for both shapes", () => {
  test("resolves the singular `file` string", () => {
    assert.equal(resolveFindingFile({ file: "src/a.mjs", line: 3 }), "src/a.mjs");
  });
  test("resolves `files[0]` for the array shape", () => {
    assert.equal(resolveFindingFile({ files: ["src/a.mjs", "src/b.mjs"], line: 3 }), "src/a.mjs");
  });
  test("prefers the singular `file` when both are present", () => {
    assert.equal(resolveFindingFile({ file: "src/a.mjs", files: ["src/b.mjs"] }), "src/a.mjs");
  });
  test("returns undefined when neither shape names a string path", () => {
    assert.equal(resolveFindingFile({ line: 3 }), undefined);
    assert.equal(resolveFindingFile({ files: [] }), undefined);
    assert.equal(resolveFindingFile({ files: [3] }), undefined);
    assert.equal(resolveFindingFile(null), undefined);
  });
  test("trims the resolved path so it matches trimmed lookup keys / is a valid `path`", () => {
    assert.equal(resolveFindingFile({ file: "src/a.mjs ", line: 2 }), "src/a.mjs");
    assert.equal(resolveFindingFile({ files: ["  src/a.mjs  "], line: 2 }), "src/a.mjs");
  });
  test("a whitespace-only `file` is absent and falls back to `files[0]`, not shadowing it", () => {
    assert.equal(resolveFindingFile({ file: "   ", files: ["src/a.mjs"], line: 2 }), "src/a.mjs");
    assert.equal(resolveFindingFile({ file: "   " }), undefined);
    assert.equal(hasLocatableShape({ file: "   ", files: ["src/a.mjs"], line: 2 }), true);
  });
  test("hasLocatableShape accepts a singular-`file` finding via the shared resolver", () => {
    assert.equal(hasLocatableShape({ file: "src/a.mjs", line: 1 }), true);
    assert.equal(hasLocatableShape({ files: ["src/a.mjs"], line: 1 }), true);
    assert.equal(hasLocatableShape({ file: "   ", line: 1 }), false);
    assert.equal(hasLocatableShape({ file: "src/a.mjs" }), false);
  });
});

describe("composeReviewVerdict / listOpenActItems", () => {
  const medium = (judgeDisposition) => ({ severity: "medium", angle: "correctness", summary: "medium issue", judgeDisposition });
  const low = (judgeDisposition) => ({ severity: "low", angle: "docs", summary: "low issue", judgeDisposition });

  test("a clean round with one judged act finding becomes findings_present", () => {
    const findings = [medium("act"), low("reject")];
    assert.equal(composeReviewVerdict("clean", findings), "findings_present");
    assert.deepEqual(listOpenActItems(findings), [findings[0]]);
  });

  test("medium and low findings all rejected or deferred stay clean", () => {
    const findings = [medium("reject"), low("defer")];
    assert.equal(composeReviewVerdict("clean", findings), "clean");
    assert.deepEqual(listOpenActItems(findings), []);
  });

  test("never lowers findings_present or blocked", () => {
    assert.equal(composeReviewVerdict("findings_present", [medium("reject")]), "findings_present");
    assert.equal(composeReviewVerdict("blocked", []), "blocked");
    assert.equal(composeReviewVerdict("blocked", [medium("act")]), "blocked");
  });

  test("a judge reject never lifts the blockCleanOnFindingSeverities floor", () => {
    const consolidated = consolidateFanin({ angleResults: [findingAngle("correctness", "high")], blockCleanOnFindingSeverities: ["high"] });
    const { findings } = applyJudgeDispositions(consolidated.findings, {
      headSha: "abc123",
      scopeDrift: { verdict: "within_scope", rationale: "diff matches the AC", driftedAreas: [] },
      dispositions: [{ index: 0, disposition: "reject", rationale: "judged out of scope", criterion: "Non-goal 1" }],
    });
    assert.equal(findings[0].judgeDisposition, "reject");
    assert.notEqual(composeReviewVerdict(consolidated.verdict, findings), "clean");
  });

  test("tolerates a missing findings list", () => {
    assert.equal(composeReviewVerdict("clean", undefined), "clean");
    assert.deepEqual(listOpenActItems(null), []);
  });
});
