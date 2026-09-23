import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  REVIEW_OPERATIONS,
  resolveOperationAnglePool,
  resolveOperationReviewerRole,
} from "../src/loop/review-operation.mjs";

// ---------------------------------------------------------------------------
// resolveOperationAnglePool — operation-pool fixtures
// ---------------------------------------------------------------------------

describe("resolveOperationAnglePool", () => {
  test("draft_gate resolves the static gates.draft pool", () => {
    const config = { gates: { draft: { angles: ["correctness", "docs"] } } };
    assert.deepEqual(resolveOperationAnglePool(config, "draft_gate"), ["correctness", "docs"]);
  });

  test("pre_approval_gate resolves the static gates.preApproval pool", () => {
    const config = { gates: { preApproval: { angles: ["security"] } } };
    assert.deepEqual(resolveOperationAnglePool(config, "pre_approval_gate"), ["security"]);
  });

  test("spike resolves the static gates.spike pool", () => {
    const config = { gates: { spike: { angles: ["scope"] } } };
    assert.deepEqual(resolveOperationAnglePool(config, "spike"), ["scope"]);
  });

  test("mandatory angle is included even when absent from the plain angles list", () => {
    const config = { gates: { draft: { angles: [{ name: "acceptance-criteria", mandatory: true }] } } };
    assert.deepEqual(resolveOperationAnglePool(config, "draft_gate"), ["acceptance-criteria"]);
  });

  test("disabled/excluded angle is removed from the pool", () => {
    const config = {
      gates: {
        draft: {
          angles: [
            "correctness",
            { name: "docs", enabled: false },
            { name: "correctness", mandatory: true }, // mandatory duplicate must not resurrect an excluded name
          ],
        },
      },
    };
    assert.deepEqual(resolveOperationAnglePool(config, "draft_gate"), ["correctness"]);
  });

  test("a mandatory angle that is also disabled stays excluded (excludeAngles is a hard ceiling)", () => {
    const config = { gates: { draft: { angles: [{ name: "docs", mandatory: true, enabled: false }] } } };
    assert.deepEqual(resolveOperationAnglePool(config, "draft_gate"), []);
  });

  test("additive pool widens draft_gate/pre_approval_gate/spike (dynamic.additive) but never widens review", () => {
    const config = {
      gates: {
        anglePool: ["correctness", "extra-lens"],
        draft: { angles: ["correctness"], dynamic: { additive: true } },
        preApproval: { angles: [] },
      },
    };
    const draftPool = resolveOperationAnglePool(config, "draft_gate");
    assert.ok(draftPool.includes("extra-lens"), "draft_gate pool must widen to the additive catalog");
    const reviewPool = resolveOperationAnglePool(config, "review");
    assert.equal(reviewPool.includes("extra-lens"), false, "standalone review must stay on the STATIC pool, no additive widening");
  });

  test("standalone review is the de-duplicated union of the static draft + preApproval angle sets", () => {
    const config = {
      gates: {
        draft: { angles: ["correctness", "docs"] },
        preApproval: { angles: ["docs", "security"] },
      },
    };
    assert.deepEqual(resolveOperationAnglePool(config, "review"), ["correctness", "docs", "security"]);
  });

  test("an angle legal only for another operation is rejected (cross-operation negative)", () => {
    const config = {
      gates: {
        draft: { angles: [] },
        preApproval: { angles: ["security"] },
        spike: { angles: [] },
      },
    };
    assert.equal(resolveOperationAnglePool(config, "draft_gate").includes("security"), false);
    assert.equal(resolveOperationAnglePool(config, "spike").includes("security"), false);
    assert.equal(resolveOperationAnglePool(config, "pre_approval_gate").includes("security"), true);
  });

  test("an angle configured only for spike is rejected by draft_gate/pre_approval_gate/review", () => {
    const config = { gates: { draft: { angles: [] }, preApproval: { angles: [] }, spike: { angles: ["spike-only-lens"] } } };
    assert.deepEqual(resolveOperationAnglePool(config, "spike"), ["spike-only-lens"]);
    assert.equal(resolveOperationAnglePool(config, "draft_gate").includes("spike-only-lens"), false);
    assert.equal(resolveOperationAnglePool(config, "pre_approval_gate").includes("spike-only-lens"), false);
    assert.equal(resolveOperationAnglePool(config, "review").includes("spike-only-lens"), false);
  });

  test("an unconfigured gate resolves an empty pool, not null", () => {
    assert.deepEqual(resolveOperationAnglePool({}, "draft_gate"), []);
    assert.deepEqual(resolveOperationAnglePool({}, "review"), []);
  });

  test("an unknown operation throws", () => {
    assert.throws(() => resolveOperationAnglePool({}, "unknown_op"));
    assert.throws(() => resolveOperationAnglePool({}, "draft"), /Unknown review operation/);
    assert.throws(() => resolveOperationAnglePool({}, "preApproval"));
  });

  test("REVIEW_OPERATIONS is the exact closed, frozen vocabulary", () => {
    assert.deepEqual([...REVIEW_OPERATIONS], ["draft_gate", "pre_approval_gate", "review", "spike"]);
    assert.ok(Object.isFrozen(REVIEW_OPERATIONS));
  });

  test("a merged config shape resolveGateConfig itself rejects throws (standalone review must fail loudly, unchanged from main)", () => {
    const config = { gates: { draft: { angles: [], blockCleanOnFindingSeverities: [] } } };
    assert.throws(() => resolveOperationAnglePool(config, "draft_gate"));
  });
});

// ---------------------------------------------------------------------------
// resolveOperationReviewerRole — exhaustive realizable-state table
//
// config-error {absent,present} x membership {member,non-member} x
// role-shape {concrete-with-prompt, concrete-without-prompt,
// fallback-without-prompt} x operation {draft_gate,pre_approval_gate,review,spike}
// = 48 rows. `fallback-with-prompt` is deliberately excluded: under
// resolveReviewerRole a fallback role always carries prompt:null, so it is not
// a realizable production state.
// ---------------------------------------------------------------------------

const ANGLE = "test-angle";

// Per-operation gate to place a MEMBER entry in, and a DIFFERENT gate (never
// part of that operation's pool) to place a NON-MEMBER entry in — proving the
// non-member's concrete role still resolves (findAngleEntry has no operation
// concept) while operation membership still fails closed.
const OPERATION_GATES = {
  draft_gate: { memberGate: "draft", otherGate: "preApproval" },
  pre_approval_gate: { memberGate: "preApproval", otherGate: "draft" },
  review: { memberGate: "draft", otherGate: "spike" },
  spike: { memberGate: "spike", otherGate: "draft" },
};

const ROLE_SHAPES = ["concrete-with-prompt", "concrete-without-prompt", "fallback-without-prompt"];

function buildConfig({ operation, member, roleShape }) {
  const { memberGate, otherGate } = OPERATION_GATES[operation];
  const gates = { draft: { angles: [] }, preApproval: { angles: [] }, spike: { angles: [] } };
  if (roleShape === "fallback-without-prompt") {
    if (member) gates[memberGate].angles = [ANGLE]; // configured, no dedicated persona entry
    // non-member + fallback-without-prompt: angle appears nowhere at all.
    return { gates };
  }
  const entry = { name: ANGLE, persona: "test-persona" };
  if (roleShape === "concrete-with-prompt") entry.prompt = "Focus on the thing that matters.";
  gates[member ? memberGate : otherGate].angles = [entry];
  return { gates };
}

function expectedStatus({ configErrorPresent, member, roleShape }) {
  if (configErrorPresent) return "config-error";
  if (!member) return "non-member";
  if (roleShape === "fallback-without-prompt") return "fallback";
  if (roleShape === "concrete-without-prompt") return "prompt-missing";
  return "resolved";
}

describe("resolveOperationReviewerRole — exhaustive realizable-state table (48 rows)", () => {
  const rows = [];
  for (const configErrorPresent of [false, true]) {
    for (const member of [true, false]) {
      for (const roleShape of ROLE_SHAPES) {
        for (const operation of REVIEW_OPERATIONS) {
          rows.push({ configErrorPresent, member, roleShape, operation });
        }
      }
    }
  }

  test("the generated table covers exactly 48 rows", () => {
    assert.equal(rows.length, 48);
  });

  for (const row of rows) {
    const { configErrorPresent, member, roleShape, operation } = row;
    const label = `config-error=${configErrorPresent} membership=${member ? "member" : "non-member"} role-shape=${roleShape} operation=${operation}`;
    test(label, () => {
      const config = buildConfig({ operation, member, roleShape });
      const loadResult = { config, errors: configErrorPresent ? [{ path: ".devloops", message: "boom", layer: "devloops" }] : [] };
      const result = resolveOperationReviewerRole(loadResult, { operation, angle: ANGLE, harness: "claude" });
      assert.equal(result.ok, !configErrorPresent && member, label);
      assert.equal(result.status, expectedStatus({ configErrorPresent, member, roleShape }), label);
      assert.equal(result.operation, operation);
      assert.equal(result.angle, ANGLE);
      assert.equal(result.harness, "claude");
      assert.deepEqual(result.configErrors, loadResult.errors);
    });
  }
});

describe("resolveOperationReviewerRole — pool-resolution throw handling", () => {
  test("a merged config shape resolveGateConfig itself rejects degrades to an empty pool, never throws, when configErrors is non-empty", () => {
    const config = { gates: { draft: { angles: [], blockCleanOnFindingSeverities: [] } } };
    const loadResult = { config, errors: [{ path: ".devloops", message: "boom", layer: "devloops" }] };
    const result = resolveOperationReviewerRole(loadResult, { operation: "draft_gate", angle: "correctness", harness: "claude" });
    assert.equal(result.ok, false);
    assert.equal(result.status, "config-error");
  });

  test("a merged config shape resolveGateConfig itself rejects rethrows when configErrors is empty", () => {
    const config = { gates: { draft: { angles: [], blockCleanOnFindingSeverities: [] } } };
    const loadResult = { config, errors: [] };
    assert.throws(() => resolveOperationReviewerRole(loadResult, { operation: "draft_gate", angle: "correctness", harness: "claude" }));
  });
});

describe("resolveOperationReviewerRole — payload shape", () => {
  test("a concrete-with-prompt member returns persona/prompt/model and ok:true", () => {
    const config = { gates: { draft: { angles: [{ name: "correctness", prompt: "Check the logic." }] } } };
    const result = resolveOperationReviewerRole({ config, errors: [] }, { operation: "draft_gate", angle: "correctness", harness: "claude" });
    assert.equal(result.ok, true);
    assert.equal(result.status, "resolved");
    assert.equal(result.persona, "review");
    assert.equal(typeof result.prompt, "string");
    assert.notEqual(result.model, undefined);
    assert.equal(result.fallback, false);
  });

  test("harness threads through to the authoritative merged model resolution", () => {
    const config = {
      gates: { draft: { angles: [{ name: ANGLE, persona: "test-persona", model: "claude-x" }] } },
    };
    const result = resolveOperationReviewerRole({ config, errors: [] }, { operation: "draft_gate", angle: ANGLE, harness: "claude" });
    assert.equal(result.model, "claude-x");
  });
});
