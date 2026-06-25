import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  consolidateFanin,
  toFindingsLogShape,
  planFanoutBatches,
  DEFAULT_MAX_FANOUT_REVIEWERS,
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
