import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  HARNESS_VALUES,
  PROHIBITED_REVIEWER_OPERATIONS,
  REVIEWER_UNIT_BUDGET,
  REVIEWER_UNIT_MAX_ANGLES,
  assertReviewerOperationAllowed,
  enforceReviewerUnitBound,
  validateReviewerUnit,
} from "../src/loop/reviewer-unit-bound.mjs";

function baseUnit(overrides = {}) {
  return {
    run: "run-1",
    gateContext: { headSha: "abc123" },
    angles: ["coverage", "security"],
    ...overrides,
  };
}

const EXPECTED_PROHIBITED_KINDS = [
  "poll_pr_state",
  "poll_ci_state",
  "poll_copilot_state",
  "network_status_probe",
  "rerun_validation",
  "inspect_orchestration_runtime",
  "review_unassigned_angle",
];

describe("reviewer-unit-bound — explicit-enumeration conformance", () => {
  test("PROHIBITED_REVIEWER_OPERATIONS contains exactly the 7 named kinds", () => {
    assert.equal(PROHIBITED_REVIEWER_OPERATIONS.size, EXPECTED_PROHIBITED_KINDS.length);
    for (const kind of EXPECTED_PROHIBITED_KINDS) {
      assert.equal(PROHIBITED_REVIEWER_OPERATIONS.has(kind), true, `expected prohibited set to contain ${kind}`);
    }
  });

  test("REVIEWER_UNIT_BUDGET equals the fixed budget", () => {
    assert.deepEqual(REVIEWER_UNIT_BUDGET, { maxModelTurns: 45, maxToolCalls: 50, maxAngles: 3 });
  });

  test("REVIEWER_UNIT_MAX_ANGLES is 3", () => {
    assert.equal(REVIEWER_UNIT_MAX_ANGLES, 3);
  });

  test("HARNESS_VALUES matches the three recognized dev-loop harnesses", () => {
    assert.deepEqual(HARNESS_VALUES, ["pi", "claude", "codex"]);
  });
});

describe("validateReviewerUnit — malformed unit fails closed", () => {
  test("throws TypeError on a missing/non-object unit", () => {
    assert.throws(() => validateReviewerUnit(null), TypeError);
    assert.throws(() => validateReviewerUnit("nope"), TypeError);
  });

  test("throws TypeError on missing/empty run", () => {
    assert.throws(() => validateReviewerUnit(baseUnit({ run: "" })), TypeError);
    assert.throws(() => validateReviewerUnit(baseUnit({ run: undefined })), TypeError);
  });

  test("throws TypeError on missing/non-object gateContext", () => {
    assert.throws(() => validateReviewerUnit(baseUnit({ gateContext: undefined })), TypeError);
    assert.throws(() => validateReviewerUnit(baseUnit({ gateContext: "nope" })), TypeError);
  });

  test("throws TypeError on missing/empty headSha", () => {
    assert.throws(() => validateReviewerUnit(baseUnit({ gateContext: {} })), TypeError);
    assert.throws(() => validateReviewerUnit(baseUnit({ gateContext: { headSha: "" } })), TypeError);
  });

  test("throws TypeError on empty angles", () => {
    assert.throws(() => validateReviewerUnit(baseUnit({ angles: [] })), TypeError);
  });

  test("throws TypeError on a non-array angles", () => {
    assert.throws(() => validateReviewerUnit(baseUnit({ angles: "coverage" })), TypeError);
  });

  test("throws TypeError on an angle that is not a non-empty string", () => {
    assert.throws(() => validateReviewerUnit(baseUnit({ angles: ["coverage", ""] })), TypeError);
    assert.throws(() => validateReviewerUnit(baseUnit({ angles: [123] })), TypeError);
  });

  test("throws TypeError on duplicate angles (case-insensitive)", () => {
    assert.throws(() => validateReviewerUnit(baseUnit({ angles: ["coverage", "Coverage"] })), TypeError);
  });

  test("throws TypeError on > 3 angles", () => {
    assert.throws(() => validateReviewerUnit(baseUnit({ angles: ["a", "b", "c", "d"] })), TypeError);
  });
});

describe("validateReviewerUnit — immutable gate context", () => {
  test("returns a frozen gateContext, unit, and angles", () => {
    const unit = validateReviewerUnit(baseUnit());
    assert.equal(Object.isFrozen(unit), true);
    assert.equal(Object.isFrozen(unit.gateContext), true);
    assert.equal(Object.isFrozen(unit.angles), true);
    assert.throws(() => {
      "use strict";
      unit.gateContext.headSha = "mutated";
    }, TypeError);
    assert.equal(unit.gateContext.headSha, "abc123");
  });

  test("normalizes run + angles by trimming", () => {
    const unit = validateReviewerUnit(baseUnit({ run: "  run-1  ", angles: [" coverage ", "security"] }));
    assert.equal(unit.run, "run-1");
    assert.deepEqual(unit.angles, ["coverage", "security"]);
  });
});

describe("assertReviewerOperationAllowed — prohibited-probe traps (table-driven)", () => {
  for (const kind of EXPECTED_PROHIBITED_KINDS) {
    test(`throws naming the prohibited kind: ${kind}`, () => {
      assert.throws(
        () => assertReviewerOperationAllowed({ kind }, { assignedAngles: ["coverage"] }),
        (error) => error instanceof Error && error.message.includes(kind),
      );
    });
  }

  test("review_angle with an unassigned angle throws review_unassigned_angle", () => {
    assert.throws(
      () => assertReviewerOperationAllowed({ kind: "review_angle", angle: "performance" }, { assignedAngles: ["coverage"] }),
      (error) => error instanceof Error && error.message.includes("review_unassigned_angle"),
    );
  });

  test("review_angle with no angle field throws review_unassigned_angle", () => {
    assert.throws(
      () => assertReviewerOperationAllowed({ kind: "review_angle" }, { assignedAngles: ["coverage"] }),
      (error) => error instanceof Error && error.message.includes("review_unassigned_angle"),
    );
  });

  test("an unknown kind throws unknown_reviewer_operation (default-deny)", () => {
    assert.throws(
      () => assertReviewerOperationAllowed({ kind: "delete_repo" }, { assignedAngles: ["coverage"] }),
      (error) => error instanceof Error && error.message.includes("unknown_reviewer_operation"),
    );
  });

  test("a malformed operation (no string kind) throws TypeError", () => {
    assert.throws(() => assertReviewerOperationAllowed(null), TypeError);
    assert.throws(() => assertReviewerOperationAllowed({}), TypeError);
    assert.throws(() => assertReviewerOperationAllowed({ kind: "" }), TypeError);
    assert.throws(() => assertReviewerOperationAllowed({ kind: 123 }), TypeError);
  });

  test("allowed kinds return the operation unchanged, do not throw", () => {
    const diffOp = { kind: "inspect_diff" };
    assert.equal(assertReviewerOperationAllowed(diffOp, { assignedAngles: ["coverage"] }), diffOp);

    const adjacentOp = { kind: "inspect_adjacent_code" };
    assert.equal(assertReviewerOperationAllowed(adjacentOp, { assignedAngles: ["coverage"] }), adjacentOp);

    const reviewOp = { kind: "review_angle", angle: "Coverage" };
    assert.equal(assertReviewerOperationAllowed(reviewOp, { assignedAngles: ["coverage"] }), reviewOp);
  });
});

for (const harness of ["pi", "claude", "codex"]) {
  describe(`enforceReviewerUnitBound — cross-harness parity (harness=${harness})`, () => {
    test("budget exhaustion (toolCalls) on a singleton unit blocks even with the angle completed", () => {
      const unit = baseUnit({ angles: ["coverage"], gateContext: { headSha: "sha-1", harness } });
      const result = enforceReviewerUnitBound({
        unit,
        consumed: { modelTurns: 1, toolCalls: 51 },
        completedAngles: ["coverage"],
      });
      assert.equal(result.ok, false);
      assert.equal(result.verdict, "blocked");
      assert.equal(result.reason, "reviewer_budget_exhausted");
      assert.deepEqual(result.unreviewedAngles, ["coverage"]);
      assert.equal(result.headSha, "sha-1");
    });

    test("budget exhaustion (modelTurns) alone blocks", () => {
      const unit = baseUnit({ angles: ["coverage"], gateContext: { headSha: "sha-2", harness } });
      const result = enforceReviewerUnitBound({
        unit,
        consumed: { modelTurns: 46, toolCalls: 0 },
        completedAngles: ["coverage"],
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "reviewer_budget_exhausted");
    });

    test("incomplete coverage within budget blocks naming exactly the missing angle", () => {
      const unit = baseUnit({ angles: ["coverage", "security", "performance"], gateContext: { headSha: "sha-3", harness } });
      const result = enforceReviewerUnitBound({
        unit,
        consumed: { modelTurns: 10, toolCalls: 10 },
        completedAngles: ["coverage", "Security"],
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "reviewer_coverage_incomplete");
      assert.deepEqual(result.unreviewedAngles, ["performance"]);
      assert.equal(result.headSha, "sha-3");
    });

    test("all angles completed within budget is clean", () => {
      const unit = baseUnit({ angles: ["coverage", "security"], gateContext: { headSha: "sha-4", harness } });
      const result = enforceReviewerUnitBound({
        unit,
        consumed: { modelTurns: 5, toolCalls: 5 },
        completedAngles: ["Coverage", "security"],
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.reviewedAngles, ["coverage", "security"]);
    });

    test("identical results (deepEqual + byte-identical JSON) across harnesses given the same body", () => {
      const unit = baseUnit({ angles: ["coverage", "security"], gateContext: { headSha: "sha-parity", harness } });
      const result = enforceReviewerUnitBound({
        unit,
        consumed: { modelTurns: 5, toolCalls: 5 },
        completedAngles: ["coverage", "security"],
      });
      const stripped = JSON.parse(JSON.stringify(result));
      const strippedGateContext = { headSha: stripped.unit.gateContext.headSha };
      assert.deepEqual(strippedGateContext, { headSha: "sha-parity" });
      assert.deepEqual(stripped.reviewedAngles, ["coverage", "security"]);
      assert.equal(JSON.stringify(stripped.consumed), JSON.stringify({ modelTurns: 5, toolCalls: 5 }));
    });
  });
}

describe("enforceReviewerUnitBound — malformed consumed fails closed", () => {
  test("throws TypeError on a missing/non-object consumed", () => {
    assert.throws(() => enforceReviewerUnitBound({ unit: baseUnit(), consumed: null }), TypeError);
  });

  test("throws TypeError on negative/non-finite modelTurns or toolCalls", () => {
    assert.throws(() => enforceReviewerUnitBound({ unit: baseUnit(), consumed: { modelTurns: -1, toolCalls: 0 } }), TypeError);
    assert.throws(() => enforceReviewerUnitBound({ unit: baseUnit(), consumed: { modelTurns: 0, toolCalls: Infinity } }), TypeError);
    assert.throws(() => enforceReviewerUnitBound({ unit: baseUnit(), consumed: { modelTurns: "1", toolCalls: 0 } }), TypeError);
  });

  test("propagates validateReviewerUnit's TypeError for a malformed unit", () => {
    assert.throws(() => enforceReviewerUnitBound({ unit: baseUnit({ run: "" }), consumed: { modelTurns: 0, toolCalls: 0 } }), TypeError);
  });

  test("throws TypeError on a bare-string completedAngles instead of iterating per-character", () => {
    assert.throws(
      () => enforceReviewerUnitBound({ unit: baseUnit(), consumed: { modelTurns: 0, toolCalls: 0 }, completedAngles: "coverage" }),
      TypeError,
    );
  });

  test("throws TypeError on a non-iterable completedAngles (number or plain object)", () => {
    assert.throws(
      () => enforceReviewerUnitBound({ unit: baseUnit(), consumed: { modelTurns: 0, toolCalls: 0 }, completedAngles: 123 }),
      TypeError,
    );
    assert.throws(
      () => enforceReviewerUnitBound({ unit: baseUnit(), consumed: { modelTurns: 0, toolCalls: 0 }, completedAngles: {} }),
      TypeError,
    );
  });

  test("still accepts undefined and an array of angle names as completedAngles (positive control)", () => {
    const undefinedResult = enforceReviewerUnitBound({ unit: baseUnit(), consumed: { modelTurns: 0, toolCalls: 0 }, completedAngles: undefined });
    assert.equal(undefinedResult.ok, false);
    assert.equal(undefinedResult.reason, "reviewer_coverage_incomplete");

    const arrayResult = enforceReviewerUnitBound({
      unit: baseUnit(),
      consumed: { modelTurns: 0, toolCalls: 0 },
      completedAngles: ["coverage", "security"],
    });
    assert.equal(arrayResult.ok, true);
  });
});

describe("enforceReviewerUnitBound — head attribution", () => {
  test("blocked result echoes headSha from the frozen gate context", () => {
    const unit = baseUnit({ angles: ["coverage"], gateContext: { headSha: "head-abc" } });
    const result = enforceReviewerUnitBound({ unit, consumed: { modelTurns: 0, toolCalls: 0 }, completedAngles: [] });
    assert.equal(result.ok, false);
    assert.equal(result.headSha, "head-abc");
    assert.equal(result.unit.gateContext.headSha, "head-abc");
    assert.equal(Object.isFrozen(result.unit.gateContext), true);
  });
});
