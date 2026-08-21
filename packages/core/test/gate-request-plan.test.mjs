import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  buildRequestPlan,
  makeHarnessCapability,
  CLAUDE_CODE_HARNESS_CAPABILITY,
  CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
  TTL_INTENT_HARNESS_MANAGED,
  DEFAULT_CALLER_TTL_INTENT,
  INHERIT_MODEL_KEY,
} from "../src/loop/gate-request-plan.mjs";

function baseInput(overrides = {}) {
  return {
    gate: "pre_approval_gate",
    headSha: "abc1234",
    sharedPrefixPath: "tmp/gate-context/owner-repo/pr-1/pre_approval_gate-abc1234.briefing-prefix.txt",
    sharedPrefixHash: "sha256:deadbeef",
    angleModels: [
      { angle: "correctness", model: "opus" },
      { angle: "security", model: "opus" },
      { angle: "docs", model: null },
    ],
    harnessCapability: CLAUDE_CODE_HARNESS_CAPABILITY,
    toolDefinitions: ["Read", "Grep", "Bash"],
    instructions: "system+agent instructions",
    settings: { thinking: "extended", toolChoice: "auto" },
    blockBoundaries: ["shared_prefix", "cache_boundary", "volatile_tail"],
    ...overrides,
  };
}

// ── Harness capability ──────────────────────────────────────────────────────

describe("makeHarnessCapability", () => {
  test("accepts every declared value combination", () => {
    const cap = makeHarnessCapability({ streaming: "streaming", cacheTelemetry: "available", ttlOwnership: "caller_controlled" });
    assert.deepEqual(cap, { streaming: "streaming", cacheTelemetry: "available", ttlOwnership: "caller_controlled" });
  });

  test("rejects an undeclared/inferred streaming value", () => {
    assert.throws(
      () => makeHarnessCapability({ streaming: "yes", cacheTelemetry: "available", ttlOwnership: "caller_controlled" }),
      /streaming must be one of/,
    );
  });

  test("rejects a missing field rather than defaulting it", () => {
    assert.throws(
      () => makeHarnessCapability({ cacheTelemetry: "available", ttlOwnership: "caller_controlled" }),
      /streaming must be one of/,
    );
  });

  test("CLAUDE_CODE_HARNESS_CAPABILITY declares an honest opaque/unavailable/harness-managed default", () => {
    assert.deepEqual(CLAUDE_CODE_HARNESS_CAPABILITY, {
      streaming: "opaque",
      cacheTelemetry: "unavailable",
      ttlOwnership: "harness_managed",
    });
  });

  test("returned capability is frozen (no accidental mutation of a shared constant)", () => {
    assert.throws(() => { CLAUDE_CODE_HARNESS_CAPABILITY.streaming = "streaming"; }, TypeError);
  });
});

// ── buildRequestPlan: shape + determinism ───────────────────────────────────

describe("buildRequestPlan: shape", () => {
  test("returns the #1468-A artifact shape with stable top-level key order", () => {
    const plan = buildRequestPlan(baseInput());
    assert.deepEqual(Object.keys(plan), ["gate", "headSha", "sharedPrefixPath", "sharedPrefixHash", "requestGroups"]);
    assert.equal(plan.gate, "pre_approval_gate");
    assert.equal(plan.headSha, "abc1234");
  });

  test("partitions angles by concrete model; angles sharing a model share one group", () => {
    const plan = buildRequestPlan(baseInput());
    const opusGroup = plan.requestGroups.find((g) => g.model === "opus");
    assert.deepEqual(opusGroup.angles, ["correctness", "security"]);
  });

  test("an angle with model:null forms its own explicit 'inherit' bucket, never merged with a concrete id", () => {
    const plan = buildRequestPlan(baseInput());
    const inheritGroup = plan.requestGroups.find((g) => g.model === INHERIT_MODEL_KEY);
    assert.ok(inheritGroup, "inherit group present");
    assert.deepEqual(inheritGroup.angles, ["docs"]);
    assert.equal(plan.requestGroups.length, 2, "opus and inherit stay separate groups");
  });

  test("groups are sorted by model; angles within a group are sorted", () => {
    const plan = buildRequestPlan(baseInput({
      angleModels: [
        { angle: "zeta", model: "opus" },
        { angle: "alpha", model: "opus" },
        { angle: "beta", model: "sonnet" },
      ],
    }));
    assert.deepEqual(plan.requestGroups.map((g) => g.model), ["opus", "sonnet"]);
    assert.deepEqual(plan.requestGroups[0].angles, ["alpha", "zeta"]);
  });

  test("each group carries cacheBoundary and requestPrefixFingerprint fields", () => {
    const plan = buildRequestPlan(baseInput());
    for (const group of plan.requestGroups) {
      assert.equal(group.cacheBoundary, CACHE_BOUNDARY_AFTER_SHARED_PREFIX);
      assert.match(group.requestPrefixFingerprint, /^sha256:[0-9a-f]{64}$/);
    }
  });

  test("empty angleModels produces an empty requestGroups array (no throw)", () => {
    const plan = buildRequestPlan(baseInput({ angleModels: [] }));
    assert.deepEqual(plan.requestGroups, []);
  });

  test("an angle listed twice under two different models throws", () => {
    assert.throws(
      () => buildRequestPlan(baseInput({
        angleModels: [
          { angle: "correctness", model: "opus" },
          { angle: "correctness", model: "sonnet" },
        ],
      })),
      /listed with two different models/,
    );
  });

  test("throws on a missing harnessCapability", () => {
    assert.throws(() => buildRequestPlan(baseInput({ harnessCapability: null })), /harnessCapability is required/);
  });

  test("throws on a harnessCapability missing a field, rather than silently accepting it (routed through makeHarnessCapability)", () => {
    assert.throws(
      () => buildRequestPlan(baseInput({ harnessCapability: { streaming: "opaque", cacheTelemetry: "unavailable" } })),
      /ttlOwnership must be one of/,
    );
  });

  test("throws on a harnessCapability with a typo'd ttlOwnership value, rather than silently deriving a caller-controlled ttlIntent", () => {
    assert.throws(
      () => buildRequestPlan(baseInput({ harnessCapability: { streaming: "opaque", cacheTelemetry: "unavailable", ttlOwnership: "harness-managed" } })),
      /ttlOwnership must be one of/,
    );
  });

  test("a concrete model literally named 'inherit' throws (would collide with the reserved bucket key)", () => {
    assert.throws(
      () => buildRequestPlan(baseInput({ angleModels: [{ angle: "correctness", model: "inherit" }] })),
      /collides with the bucket key reserved for "no override"/,
    );
  });
});

// ── ttlIntent derivation ────────────────────────────────────────────────────

describe("buildRequestPlan: ttlIntent", () => {
  test("harness_managed ttlOwnership stamps ttlIntent 'harness_managed'", () => {
    const plan = buildRequestPlan(baseInput());
    for (const group of plan.requestGroups) assert.equal(group.ttlIntent, TTL_INTENT_HARNESS_MANAGED);
  });

  test("caller_controlled ttlOwnership defaults ttlIntent to '5m'", () => {
    const capability = makeHarnessCapability({ streaming: "streaming", cacheTelemetry: "available", ttlOwnership: "caller_controlled" });
    const plan = buildRequestPlan(baseInput({ harnessCapability: capability }));
    for (const group of plan.requestGroups) assert.equal(group.ttlIntent, DEFAULT_CALLER_TTL_INTENT);
  });

  test("an explicit ttlIntent override wins over the derived default", () => {
    const plan = buildRequestPlan(baseInput({ ttlIntent: "1h" }));
    for (const group of plan.requestGroups) assert.equal(group.ttlIntent, "1h");
  });

  test("rejects an explicit ttlIntent outside the closed vocabulary, rather than writing it through verbatim", () => {
    assert.throws(
      () => buildRequestPlan(baseInput({ ttlIntent: "30s" })),
      /ttlIntent must be one of/,
    );
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("buildRequestPlan: determinism", () => {
  test("two builds of identical input produce byte-identical JSON", () => {
    const input = baseInput();
    const a = JSON.stringify(buildRequestPlan(input));
    const b = JSON.stringify(buildRequestPlan(baseInput()));
    assert.equal(a, b);
  });

  test("input key order does not affect output (settings object canonicalized)", () => {
    const a = buildRequestPlan(baseInput({ settings: { thinking: "extended", toolChoice: "auto" } }));
    const b = buildRequestPlan(baseInput({ settings: { toolChoice: "auto", thinking: "extended" } }));
    assert.deepEqual(a, b);
  });

  test("requestGroups order is independent of angleModels input order (Map insertion order alone would be silently order-dependent)", () => {
    const ordered = baseInput({
      angleModels: [
        { angle: "correctness", model: "opus" },
        { angle: "docs", model: null },
        { angle: "security", model: "sonnet" },
      ],
    });
    const permuted = baseInput({
      angleModels: [
        { angle: "security", model: "sonnet" },
        { angle: "correctness", model: "opus" },
        { angle: "docs", model: null },
      ],
    });
    assert.equal(JSON.stringify(buildRequestPlan(ordered)), JSON.stringify(buildRequestPlan(permuted)));
  });
});

// ── requestPrefixFingerprint: changes for each cache-relevant input class ──

describe("buildRequestPlan: requestPrefixFingerprint sensitivity", () => {
  function fingerprintOf(plan, model) {
    return plan.requestGroups.find((g) => g.model === model).requestPrefixFingerprint;
  }

  test("changes when the model changes", () => {
    const a = fingerprintOf(buildRequestPlan(baseInput()), "opus");
    const b = fingerprintOf(
      buildRequestPlan(baseInput({ angleModels: [{ angle: "correctness", model: "sonnet" }] })),
      "sonnet",
    );
    assert.notEqual(a, b);
  });

  test("changes when the tool set/order changes", () => {
    const a = fingerprintOf(buildRequestPlan(baseInput()), "opus");
    const b = fingerprintOf(buildRequestPlan(baseInput({ toolDefinitions: ["Bash", "Grep", "Read"] })), "opus");
    assert.notEqual(a, b, "reordering the SAME tool set must still change the fingerprint (order is cache-relevant)");
  });

  test("changes when instructions change", () => {
    const a = fingerprintOf(buildRequestPlan(baseInput()), "opus");
    const b = fingerprintOf(buildRequestPlan(baseInput({ instructions: "different instructions" })), "opus");
    assert.notEqual(a, b);
  });

  test("changes when settings (thinking/tool-choice) change", () => {
    const a = fingerprintOf(buildRequestPlan(baseInput()), "opus");
    const b = fingerprintOf(buildRequestPlan(baseInput({ settings: { thinking: "off", toolChoice: "auto" } })), "opus");
    assert.notEqual(a, b);
  });

  test("changes when content-block boundaries change", () => {
    const a = fingerprintOf(buildRequestPlan(baseInput()), "opus");
    const b = fingerprintOf(buildRequestPlan(baseInput({ blockBoundaries: ["shared_prefix", "volatile_tail"] })), "opus");
    assert.notEqual(a, b);
  });

  test("changes when the shared artifact bytes (sharedPrefixHash) change", () => {
    const a = fingerprintOf(buildRequestPlan(baseInput()), "opus");
    const b = fingerprintOf(buildRequestPlan(baseInput({ sharedPrefixHash: "sha256:00000000" })), "opus");
    assert.notEqual(a, b);
  });

  test("changes when TTL/breakpoint intent changes", () => {
    const a = fingerprintOf(buildRequestPlan(baseInput()), "opus");
    const b = fingerprintOf(buildRequestPlan(baseInput({ ttlIntent: "1h" })), "opus");
    assert.notEqual(a, b);
  });

  test("does NOT change when only the angle suffix (angle set within a group) changes", () => {
    const a = fingerprintOf(buildRequestPlan(baseInput()), "opus");
    const b = fingerprintOf(
      buildRequestPlan(baseInput({
        angleModels: [
          { angle: "correctness", model: "opus" },
          { angle: "security", model: "opus" },
          { angle: "docs", model: null },
          { angle: "threat-model", model: "opus" },
        ],
      })),
      "opus",
    );
    assert.equal(a, b, "the angle list is the volatile suffix — never a fingerprint input");
  });

  test("throws on a non-finite number in settings, rather than collapsing it to JSON null", () => {
    assert.throws(
      () => buildRequestPlan(baseInput({ settings: { temperature: NaN } })),
      /non-finite number/,
    );
    assert.throws(
      () => buildRequestPlan(baseInput({ settings: { temperature: Infinity } })),
      /non-finite number/,
    );
  });

  test("throws on a non-plain object in settings (Date/Map/Set are keyless and would collide with {})", () => {
    assert.throws(() => buildRequestPlan(baseInput({ settings: { at: new Date() } })), /not a plain object/);
    assert.throws(() => buildRequestPlan(baseInput({ settings: { m: new Map() } })), /not a plain object/);
    assert.throws(() => buildRequestPlan(baseInput({ settings: { s: new Set() } })), /not a plain object/);
  });

  test("an own __proto__ key in settings is preserved (not silently dropped by a plain-object accumulator)", () => {
    const settingsWithProto = JSON.parse('{"__proto__":{"a":1}}');
    const a = fingerprintOf(buildRequestPlan(baseInput({ settings: settingsWithProto })), "opus");
    const b = fingerprintOf(buildRequestPlan(baseInput({ settings: JSON.parse('{"__proto__":{"a":2}}') })), "opus");
    assert.notEqual(a, b, "two settings objects differing only under __proto__ must not hash identically");
  });
});
