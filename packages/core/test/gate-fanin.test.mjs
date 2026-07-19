import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  consolidateFanin,
  toFindingsLogShape,
  planFanoutBatches,
  DEFAULT_MAX_FANOUT_REVIEWERS,
  FANOUT_UNAVAILABLE_MESSAGE,
  fanoutUnavailableError,
  countDistinctReviewers,
  provenanceConsistencyError,
  checkFanoutAngleCoverage,
  countFreshAngles,
  fanoutReviewerPairingError,
} from "../src/loop/gate-fanin.mjs";

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

  test("findings_present when a blocking-severity finding remains (default must-fix)", () => {
    const result = consolidateFanin({
      angleResults: [cleanAngle("scope"), findingAngle("correctness", "must-fix")],
    });
    assert.equal(result.verdict, "findings_present");
    assert.equal(result.counts.blocking, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].disposition, "accepted-for-fix");
  });

  test("clean when only non-blocking findings remain under default policy", () => {
    const result = consolidateFanin({
      angleResults: [findingAngle("docs", "defer")],
    });
    assert.equal(result.verdict, "clean");
    assert.equal(result.counts.findings, 1);
    assert.equal(result.counts.blocking, 0);
    assert.equal(result.findings[0].disposition, "deferred");
  });

  test("severity gating: worth-fixing-now blocks only when listed", () => {
    const angleResults = [findingAngle("kiss", "worth-fixing-now")];
    assert.equal(consolidateFanin({ angleResults }).verdict, "clean");
    assert.equal(
      consolidateFanin({
        angleResults,
        blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
      }).verdict,
      "findings_present",
    );
  });

  test("blocked when any angle result is malformed/missing", () => {
    const cases = [
      [cleanAngle("scope"), null],
      [cleanAngle("scope"), { angle: "x", verdict: "bogus", findings: [] }],
      [{ angle: "x", verdict: "clean", findings: "nope" }],
      [{ verdict: "clean", findings: [] }], // missing angle
      [{ angle: "x", verdict: "findings_present", findings: [] }], // findings_present w/o findings
      [{ angle: "x", verdict: "clean", findings: [{ severity: "must-fix", summary: "y" }] }], // clean w/ findings
      [{ angle: "x", verdict: "findings_present", findings: [{ severity: "nope", summary: "y" }] }],
    ];
    for (const angleResults of cases) {
      const result = consolidateFanin({ angleResults });
      assert.equal(result.verdict, "blocked", JSON.stringify(angleResults));
      assert.ok(result.malformed.length > 0);
      assert.equal(result.findings.length, 0);
    }
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
            { severity: "must-fix", summary: "a", file: "src/a.mjs", line: 10, recommendation: "fix it" },
            { severity: "defer", summary: "b" },
          ],
        },
        findingAngle("docs", "worth-fixing-now", "c"),
        cleanAngle("kiss"),
      ],
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
    });
    assert.equal(result.verdict, "findings_present");
    assert.equal(result.counts.angles, 3);
    assert.equal(result.counts.findings, 3);
    assert.equal(result.counts.blocking, 2);
    assert.deepEqual(result.counts.bySeverity, { "must-fix": 1, "worth-fixing-now": 1, "defer": 1 });
    const scopeFinding = result.findings.find((f) => f.angle === "scope" && f.severity === "must-fix");
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
          findings: [{ severity: "must-fix", summary: "a", file: "src/a.mjs", recommendation: "x" }],
        },
        findingAngle("docs", "defer", "b"),
      ],
    });
    const shaped = toFindingsLogShape(consolidated.findings);
    assert.deepEqual(shaped, [
      { severity: "must-fix", angle: "scope", summary: "a", disposition: "accepted-for-fix", files: ["src/a.mjs"] },
      { severity: "defer", angle: "docs", summary: "b", disposition: "deferred" },
    ]);
  });

  test("tolerates missing/empty input", () => {
    assert.deepEqual(toFindingsLogShape(undefined), []);
    assert.deepEqual(toFindingsLogShape([]), []);
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

describe("countFreshAngles (#1431 — one-reviewer-per-angle enforcement)", () => {
  test("counts distinct angles without carriedFromHead", () => {
    assert.equal(countFreshAngles([]), 0);
    assert.equal(countFreshAngles([{ angle: "a" }, { angle: "b" }]), 2);
    assert.equal(countFreshAngles([{ angle: "a" }, { angle: "a" }]), 1); // dedup by angle
    assert.equal(countFreshAngles("nope"), 0);
  });

  test("excludes carried angles (carriedFromHead marks a reused, not fresh, verdict)", () => {
    assert.equal(countFreshAngles([{ angle: "a" }, { angle: "b", carriedFromHead: "abc1234" }]), 1);
    assert.equal(countFreshAngles([{ angle: "a", carriedFromHead: "abc1234" }]), 0);
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

  test("detects one reviewer collapsing two fresh angles (collision)", () => {
    const error = fanoutReviewerPairingError([
      { angle: "a", reviewer: "x" },
      { angle: "b", reviewer: "x" },
    ]);
    assert.match(error, /one-scoped-reviewer-per-angle contract/);
    assert.match(error, /reviewer "x" is recorded for fresh angles: a, b/);
    assert.match(error, /inline_single_agent/);
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
});

describe("checkFanoutAngleCoverage (#1196 — mandatory angles + angle-pool membership)", () => {
  test("passes when every mandatory angle is recorded and every angle is in the pool", () => {
    const result = checkFanoutAngleCoverage(
      [{ angle: "pr-checklist-matrix" }, { angle: "yagni" }],
      { mandatoryAngles: ["pr-checklist-matrix"], pool: ["yagni", "pr-checklist-matrix", "dry"] },
    );
    assert.deepEqual(result, { missingMandatory: [], foreignAngles: [] });
  });

  test("reports every mandatory angle absent from the recorded angles", () => {
    const result = checkFanoutAngleCoverage(
      [{ angle: "yagni" }],
      { mandatoryAngles: ["pr-checklist-matrix", "acceptance-criteria", "yagni"] },
    );
    assert.deepEqual(result.missingMandatory, ["pr-checklist-matrix", "acceptance-criteria"]);
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
      [{ angle: "pr-checklist-matrix-delta-at-current-head" }],
      { mandatoryAngles: ["pr-checklist-matrix"], pool: ["pr-checklist-matrix"] },
    );
    assert.deepEqual(result, { missingMandatory: [], foreignAngles: [] });
  });

  test("tolerates malformed/missing input (non-array, entries without a usable .angle)", () => {
    assert.deepEqual(checkFanoutAngleCoverage(undefined, { mandatoryAngles: ["a"] }).missingMandatory, ["a"]);
    assert.deepEqual(checkFanoutAngleCoverage([null, { angle: "" }, "nope"], { mandatoryAngles: [] }).foreignAngles, []);
  });
});
