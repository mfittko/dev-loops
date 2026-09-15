import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  HARNESS_VALUES,
  ROLE_BUDGETS,
  ROLE_VALUES,
  enforceRoleBudget,
  validateRoleUnit,
} from "../src/loop/role-budget-bound.mjs";

function baseUnit(role, overrides = {}) {
  return {
    role,
    run: "run-1",
    gateContext: { headSha: "abc123" },
    ...overrides,
  };
}

const ROLE_CONSUMED_DIMENSIONS = {
  judge_round: ["modelTurns", "toolCalls", "inputTokens", "outputTokens"],
  fixer_pass: ["modelTurns", "toolCalls", "pushesThisGateRound"],
};

/** @param {"judge_round"|"fixer_pass"} role @returns {object} consumed at exactly the budget max for every dimension. */
function atMaxConsumed(role) {
  const budget = ROLE_BUDGETS[role];
  if (role === "judge_round") {
    return {
      modelTurns: budget.maxModelTurns,
      toolCalls: budget.maxToolCalls,
      inputTokens: budget.maxInputTokens,
      outputTokens: budget.maxOutputTokens,
    };
  }
  return {
    modelTurns: budget.maxModelTurns,
    toolCalls: budget.maxToolCalls,
    pushesThisGateRound: budget.maxPushesPerGateRound,
  };
}

describe("role-budget-bound — explicit-enumeration conformance", () => {
  test("ROLE_VALUES matches the two roles", () => {
    assert.deepEqual(ROLE_VALUES, ["judge_round", "fixer_pass"]);
    assert.equal(Object.isFrozen(ROLE_VALUES), true);
  });

  test("HARNESS_VALUES matches the three recognized dev-loop harnesses", () => {
    assert.deepEqual(HARNESS_VALUES, ["pi", "claude", "codex"]);
    assert.equal(Object.isFrozen(HARNESS_VALUES), true);
  });

  test("ROLE_BUDGETS equals the AC-mandated fixed budgets", () => {
    assert.deepEqual(ROLE_BUDGETS, {
      judge_round: { maxModelTurns: 12, maxToolCalls: 15, maxInputTokens: 100000, maxOutputTokens: 10000 },
      fixer_pass: { maxModelTurns: 45, maxToolCalls: 50, maxPushesPerGateRound: 1 },
    });
    assert.equal(Object.isFrozen(ROLE_BUDGETS), true);
    assert.equal(Object.isFrozen(ROLE_BUDGETS.judge_round), true);
    assert.equal(Object.isFrozen(ROLE_BUDGETS.fixer_pass), true);
  });

  test("ROLE_VALUES/HARNESS_VALUES/ROLE_BUDGETS reject a mutation attempt (frozen, does not take effect)", () => {
    assert.throws(() => {
      "use strict";
      ROLE_VALUES.push("other_role");
    }, TypeError);
    assert.throws(() => {
      "use strict";
      HARNESS_VALUES.push("other_harness");
    }, TypeError);
    assert.throws(() => {
      "use strict";
      ROLE_BUDGETS.judge_round.maxModelTurns = 999;
    }, TypeError);
    assert.deepEqual(ROLE_VALUES, ["judge_round", "fixer_pass"]);
    assert.deepEqual(HARNESS_VALUES, ["pi", "claude", "codex"]);
    assert.equal(ROLE_BUDGETS.judge_round.maxModelTurns, 12);
  });
});

describe("validateRoleUnit — malformed unit fails closed", () => {
  test("throws TypeError on a missing/non-object unit", () => {
    assert.throws(() => validateRoleUnit(null), TypeError);
    assert.throws(() => validateRoleUnit("nope"), TypeError);
  });

  test("throws TypeError on a bad/missing role", () => {
    assert.throws(() => validateRoleUnit(baseUnit("judge_round", { role: "reviewer" })), TypeError);
    assert.throws(() => validateRoleUnit(baseUnit("judge_round", { role: undefined })), TypeError);
  });

  test("throws TypeError on missing/empty run", () => {
    assert.throws(() => validateRoleUnit(baseUnit("judge_round", { run: "" })), TypeError);
    assert.throws(() => validateRoleUnit(baseUnit("judge_round", { run: undefined })), TypeError);
  });

  test("throws TypeError on missing/non-object gateContext", () => {
    assert.throws(() => validateRoleUnit(baseUnit("judge_round", { gateContext: undefined })), TypeError);
    assert.throws(() => validateRoleUnit(baseUnit("judge_round", { gateContext: "nope" })), TypeError);
  });

  test("throws TypeError on missing/empty headSha", () => {
    assert.throws(() => validateRoleUnit(baseUnit("judge_round", { gateContext: {} })), TypeError);
    assert.throws(() => validateRoleUnit(baseUnit("judge_round", { gateContext: { headSha: "" } })), TypeError);
  });

  test("throws TypeError on an unrecognized gateContext.harness", () => {
    assert.throws(
      () => validateRoleUnit(baseUnit("judge_round", { gateContext: { headSha: "sha", harness: "borg" } })),
      TypeError,
    );
  });

  test("allows an absent gateContext.harness (optional field)", () => {
    const unit = validateRoleUnit(baseUnit("judge_round", { gateContext: { headSha: "sha" } }));
    assert.equal(unit.gateContext.harness, undefined);
  });

  test("throws TypeError on a non-structured-cloneable gateContext", () => {
    assert.throws(
      () => validateRoleUnit(baseUnit("judge_round", { gateContext: { headSha: "x", fn: () => {} } })),
      TypeError,
    );
  });
});

for (const role of ROLE_VALUES) {
  describe(`validateRoleUnit — immutable gate context (role=${role})`, () => {
    test("returns a frozen unit and gateContext", () => {
      const unit = validateRoleUnit(baseUnit(role));
      assert.equal(Object.isFrozen(unit), true);
      assert.equal(Object.isFrozen(unit.gateContext), true);
      assert.throws(() => {
        "use strict";
        unit.gateContext.headSha = "mutated";
      }, TypeError);
      assert.equal(unit.gateContext.headSha, "abc123");
    });

    test("normalizes run by trimming", () => {
      const unit = validateRoleUnit(baseUnit(role, { run: "  run-1  " }));
      assert.equal(unit.run, "run-1");
    });

    test("deep-freezes nested gateContext values, not just the top level", () => {
      const unit = validateRoleUnit(baseUnit(role, { gateContext: { headSha: "x", provenance: { a: 1 } } }));
      assert.equal(Object.isFrozen(unit.gateContext.provenance), true);
      assert.throws(() => {
        "use strict";
        unit.gateContext.provenance.a = 2;
      }, TypeError);
      assert.equal(unit.gateContext.provenance.a, 1);
    });

    test("never mutates the caller's gateContext: the caller's object stays unfrozen while the returned clone is deep-frozen", () => {
      const originalProvenance = { a: 1 };
      const callerGateContext = { headSha: "h", provenance: originalProvenance };
      const unit = validateRoleUnit(baseUnit(role, { gateContext: callerGateContext }));

      assert.equal(Object.isFrozen(callerGateContext), false);
      assert.equal(Object.isFrozen(originalProvenance), false);
      assert.equal(unit.gateContext.provenance === originalProvenance, false);

      assert.equal(Object.isFrozen(unit.gateContext.provenance), true);
      assert.throws(() => {
        "use strict";
        unit.gateContext.provenance.a = 2;
      }, TypeError);
      assert.equal(unit.gateContext.provenance.a, 1);
      assert.equal(originalProvenance.a, 1);
    });

    test("re-asserts headSha from a non-enumerable/inherited source lost by structuredClone", () => {
      const proto = { headSha: "inherited-sha" };
      const gateContext = Object.create(proto);
      Object.defineProperty(gateContext, "headSha", {
        value: "own-nonenumerable-sha",
        enumerable: false,
        configurable: true,
      });
      // headSha is validated via property read (own+inherited both visible),
      // but structuredClone only copies own-enumerable props — this exercises
      // the explicit post-clone re-assert.
      const unit = validateRoleUnit(baseUnit(role, { gateContext }));
      assert.equal(unit.gateContext.headSha, "own-nonenumerable-sha");
    });
  });
}

describe("enforceRoleBudget — success at exactly the budget max (last-allowed)", () => {
  for (const role of ROLE_VALUES) {
    test(`role=${role}: consumed exactly at every dimension's max is ok`, () => {
      const unit = baseUnit(role, { gateContext: { headSha: "sha-max" } });
      const result = enforceRoleBudget({ unit, consumed: atMaxConsumed(role) });
      assert.equal(result.ok, true);
      assert.equal(result.role, role);
      assert.deepEqual(result.consumed, atMaxConsumed(role));
      assert.deepEqual(result.budget, ROLE_BUDGETS[role]);
    });
  }
});

describe("enforceRoleBudget — blocked at first-disallowed, one dimension over", () => {
  test("judge_round: one over on modelTurns blocks naming modelTurns", () => {
    const unit = baseUnit("judge_round", { gateContext: { headSha: "sha-1" } });
    const consumed = { ...atMaxConsumed("judge_round"), modelTurns: ROLE_BUDGETS.judge_round.maxModelTurns + 1 };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, false);
    assert.equal(result.verdict, "blocked");
    assert.equal(result.reason, "judge_round_budget_exhausted");
    assert.deepEqual(result.exceededDimensions, ["modelTurns"]);
    assert.equal(result.headSha, "sha-1");
  });

  test("judge_round: one over on toolCalls blocks naming toolCalls", () => {
    const unit = baseUnit("judge_round", { gateContext: { headSha: "sha-2" } });
    const consumed = { ...atMaxConsumed("judge_round"), toolCalls: ROLE_BUDGETS.judge_round.maxToolCalls + 1 };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "judge_round_budget_exhausted");
    assert.deepEqual(result.exceededDimensions, ["toolCalls"]);
  });

  test("judge_round: one over on inputTokens blocks naming inputTokens", () => {
    const unit = baseUnit("judge_round", { gateContext: { headSha: "sha-3" } });
    const consumed = { ...atMaxConsumed("judge_round"), inputTokens: ROLE_BUDGETS.judge_round.maxInputTokens + 1 };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "judge_round_budget_exhausted");
    assert.deepEqual(result.exceededDimensions, ["inputTokens"]);
  });

  test("judge_round: one over on outputTokens blocks naming outputTokens", () => {
    const unit = baseUnit("judge_round", { gateContext: { headSha: "sha-4" } });
    const consumed = { ...atMaxConsumed("judge_round"), outputTokens: ROLE_BUDGETS.judge_round.maxOutputTokens + 1 };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "judge_round_budget_exhausted");
    assert.deepEqual(result.exceededDimensions, ["outputTokens"]);
  });

  test("fixer_pass: one over on modelTurns blocks naming modelTurns", () => {
    const unit = baseUnit("fixer_pass", { gateContext: { headSha: "sha-5" } });
    const consumed = { ...atMaxConsumed("fixer_pass"), modelTurns: ROLE_BUDGETS.fixer_pass.maxModelTurns + 1 };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "fixer_pass_budget_exhausted");
    assert.deepEqual(result.exceededDimensions, ["modelTurns"]);
  });

  test("fixer_pass: one over on toolCalls blocks naming toolCalls", () => {
    const unit = baseUnit("fixer_pass", { gateContext: { headSha: "sha-6" } });
    const consumed = { ...atMaxConsumed("fixer_pass"), toolCalls: ROLE_BUDGETS.fixer_pass.maxToolCalls + 1 };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "fixer_pass_budget_exhausted");
    assert.deepEqual(result.exceededDimensions, ["toolCalls"]);
  });

  test("fixer_pass: one over on pushesThisGateRound blocks naming pushesThisGateRound", () => {
    const unit = baseUnit("fixer_pass", { gateContext: { headSha: "sha-7" } });
    const consumed = {
      ...atMaxConsumed("fixer_pass"),
      pushesThisGateRound: ROLE_BUDGETS.fixer_pass.maxPushesPerGateRound + 1,
    };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "fixer_pass_budget_exhausted");
    assert.deepEqual(result.exceededDimensions, ["pushesThisGateRound"]);
  });

  test("multiple dimensions over at once are all named in exceededDimensions (judge_round)", () => {
    const unit = baseUnit("judge_round", { gateContext: { headSha: "sha-8" } });
    const consumed = {
      modelTurns: ROLE_BUDGETS.judge_round.maxModelTurns + 1,
      toolCalls: ROLE_BUDGETS.judge_round.maxToolCalls + 1,
      inputTokens: 0,
      outputTokens: ROLE_BUDGETS.judge_round.maxOutputTokens + 1,
    };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, false);
    assert.deepEqual(result.exceededDimensions, ["modelTurns", "toolCalls", "outputTokens"]);
  });

  test("multiple dimensions over at once are all named in exceededDimensions (fixer_pass)", () => {
    const unit = baseUnit("fixer_pass", { gateContext: { headSha: "sha-9" } });
    const consumed = {
      modelTurns: ROLE_BUDGETS.fixer_pass.maxModelTurns + 1,
      toolCalls: 0,
      pushesThisGateRound: ROLE_BUDGETS.fixer_pass.maxPushesPerGateRound + 1,
    };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, false);
    assert.deepEqual(result.exceededDimensions, ["modelTurns", "pushesThisGateRound"]);
  });
});

describe("enforceRoleBudget — a wrong-role consumed dimension is ignored, not accepted", () => {
  test("a fixer-only dimension present on a judge_round consumed object is ignored", () => {
    const unit = baseUnit("judge_round", { gateContext: { headSha: "sha-10" } });
    const consumed = { ...atMaxConsumed("judge_round"), pushesThisGateRound: 999 };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.consumed), ["modelTurns", "toolCalls", "inputTokens", "outputTokens"]);
  });

  test("a judge-only dimension present on a fixer_pass consumed object is ignored", () => {
    const unit = baseUnit("fixer_pass", { gateContext: { headSha: "sha-11" } });
    const consumed = { ...atMaxConsumed("fixer_pass"), inputTokens: 999999 };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.consumed), ["modelTurns", "toolCalls", "pushesThisGateRound"]);
  });

  test("a judge consumed shape (missing fixer's own dimensions) is not silently accepted for a fixer unit", () => {
    const unit = baseUnit("fixer_pass", { gateContext: { headSha: "sha-12" } });
    const judgeShapedConsumed = { modelTurns: 1, toolCalls: 1, inputTokens: 1, outputTokens: 1 };
    assert.throws(() => enforceRoleBudget({ unit, consumed: judgeShapedConsumed }), TypeError);
  });
});

describe("enforceRoleBudget — consumed validation fails closed per dimension, per role", () => {
  for (const role of ROLE_VALUES) {
    for (const dimension of ROLE_CONSUMED_DIMENSIONS[role]) {
      test(`role=${role}: missing ${dimension} throws TypeError`, () => {
        const consumed = { ...atMaxConsumed(role) };
        delete consumed[dimension];
        assert.throws(() => enforceRoleBudget({ unit: baseUnit(role), consumed }), TypeError);
      });

      test(`role=${role}: fractional ${dimension} throws TypeError`, () => {
        const consumed = { ...atMaxConsumed(role), [dimension]: 1.5 };
        assert.throws(() => enforceRoleBudget({ unit: baseUnit(role), consumed }), TypeError);
      });

      test(`role=${role}: negative ${dimension} throws TypeError`, () => {
        const consumed = { ...atMaxConsumed(role), [dimension]: -1 };
        assert.throws(() => enforceRoleBudget({ unit: baseUnit(role), consumed }), TypeError);
      });

      test(`role=${role}: non-number ${dimension} throws TypeError`, () => {
        const consumed = { ...atMaxConsumed(role), [dimension]: "1" };
        assert.throws(() => enforceRoleBudget({ unit: baseUnit(role), consumed }), TypeError);
      });
    }
  }

  test("throws TypeError on a missing/non-object consumed", () => {
    assert.throws(() => enforceRoleBudget({ unit: baseUnit("judge_round"), consumed: null }), TypeError);
    assert.throws(() => enforceRoleBudget({ unit: baseUnit("judge_round"), consumed: "nope" }), TypeError);
  });

  test("propagates validateRoleUnit's TypeError for a malformed unit", () => {
    assert.throws(
      () => enforceRoleBudget({ unit: baseUnit("judge_round", { run: "" }), consumed: atMaxConsumed("judge_round") }),
      TypeError,
    );
  });
});

describe("enforceRoleBudget — head attribution", () => {
  test("blocked result echoes headSha from the frozen gate context", () => {
    const unit = baseUnit("judge_round", { gateContext: { headSha: "head-abc" } });
    const consumed = { ...atMaxConsumed("judge_round"), modelTurns: ROLE_BUDGETS.judge_round.maxModelTurns + 1 };
    const result = enforceRoleBudget({ unit, consumed });
    assert.equal(result.ok, false);
    assert.equal(result.headSha, "head-abc");
    assert.equal(result.unit.gateContext.headSha, "head-abc");
    assert.equal(Object.isFrozen(result.unit.gateContext), true);
  });
});
