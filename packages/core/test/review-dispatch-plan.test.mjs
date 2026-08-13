import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
  CACHE_BOUNDARY_VALUES,
  HARNESS_DEFAULT_CAPABILITIES,
  PRIMER_FORM_DEDICATED,
  PRIMER_FORM_LEAD_REVIEWER,
  TTL_INTENT_VALUES,
  buildReviewDispatchPlan,
  cacheReuseVeracity,
  composeCacheAwareRequest,
  fingerprintRequestPrefix,
  fingerprintStablePrefix,
  normalizeHarnessCapabilities,
  opaqueMarker,
  partitionPrimerGroups,
  resolvePrimerForm,
  sha256Hex,
} from "../src/loop/review-dispatch-plan.mjs";

describe("normalizeHarnessCapabilities — explicit capability model (Section D)", () => {
  test("claude default posture is explicit, fixed TTL, telemetry available", () => {
    const caps = normalizeHarnessCapabilities({ harness: "claude" });
    assert.equal(caps.breakpointControl, "automatic");
    assert.equal(caps.barrierSignal, "completion_only");
    assert.equal(caps.cacheTtlControl, "fixed");
    assert.equal(caps.usageTelemetry, "available");
    assert.ok(Object.isFrozen(caps));
  });

  test("pi default posture is conservative/opaque and telemetry unavailable (fail toward no over-claim)", () => {
    const caps = normalizeHarnessCapabilities({ harness: "pi" });
    assert.equal(caps.breakpointControl, "opaque");
    assert.equal(caps.usageTelemetry, "unavailable");
  });

  test("unknown harness name fails closed", () => {
    assert.throws(() => normalizeHarnessCapabilities({ harness: "no-such" }));
  });

  test("invalid dimension value fails closed", () => {
    assert.throws(() =>
      normalizeHarnessCapabilities({ capabilities: { usageTelemetry: "definitely" } }),
    );
  });

  test("unknown dimension fails closed", () => {
    assert.throws(() =>
      normalizeHarnessCapabilities({ capabilities: { magic: "on" } }),
    );
  });

  test("explicit capabilities override defaults and are validated", () => {
    const caps = normalizeHarnessCapabilities({
      harness: "pi",
      capabilities: { barrierSignal: "first_output", cacheTtlControl: "5m_1h" },
    });
    assert.equal(caps.barrierSignal, "first_output");
    assert.equal(caps.cacheTtlControl, "5m_1h");
    assert.equal(caps.usageTelemetry, "unavailable");
  });

  test("missing dimension after overrides fails closed", () => {
    // A bare non-object capability input is rejected outright.
    assert.throws(() => normalizeHarnessCapabilities({ capabilities: "nope" }));
  });
});

describe("cacheReuseVeracity — opaque harnesses never claim verified reuse (Section D/AC-9)", () => {
  test("telemetry available -> verified", () => {
    const caps = normalizeHarnessCapabilities({ harness: "claude" });
    assert.equal(cacheReuseVeracity(caps).verified, true);
  });

  test("telemetry unavailable -> verified false with an explicit reason", () => {
    const caps = normalizeHarnessCapabilities({ harness: "pi" });
    const r = cacheReuseVeracity(caps);
    assert.equal(r.verified, false);
    assert.match(r.reason, /cannot be verified/);
  });

  test("missing capability record -> verified false", () => {
    assert.equal(cacheReuseVeracity(null).verified, false);
  });
});

describe("fingerprintRequestPrefix — complete observable prefix (Section A/AC-2)", () => {
  const base = {
    model: "anthropic/claude-opus",
    tools: ["read", "bash", "edit"],
    systemInstructions: ["You are a review agent."],
    settings: { thinking: true },
    contentBlocks: [{ type: "text", role: "briefing" }],
    sharedArtifact: "tmp/gate-context/pre_approval_gate-abc.briefing-prefix.txt",
  };

  test("covers model, tools, instructions, settings, blocks, bytes, ttl", () => {
    const { fingerprint } = fingerprintRequestPrefix(base);
    assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/);
  });

  test("is byte-deterministic: same input -> same fingerprint", () => {
    const a = fingerprintRequestPrefix(base).fingerprint;
    const b = fingerprintRequestPrefix({ ...base }).fingerprint;
    assert.equal(a, b);
  });

  test("model change changes the fingerprint (heterogeneous routing is not conflated)", () => {
    const a = fingerprintRequestPrefix(base).fingerprint;
    const c = fingerprintRequestPrefix({ ...base, model: "anthropic/claude-haiku" }).fingerprint;
    assert.notEqual(a, c);
  });

  test("ttl intent and boundary are folded in", () => {
    const a = fingerprintRequestPrefix(base).fingerprint;
    const b = fingerprintRequestPrefix({ ...base, ttlIntent: "1h", cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX }).fingerprint;
    assert.notEqual(a, b);
  });

  test("requires a non-empty concrete model", () => {
    assert.throws(() => fingerprintRequestPrefix({ model: "" }));
  });

  test("angleSuffix is folded into the fingerprint only when provided (invasive marker)", () => {
    const base = { model: "m", tools: ["read"] };
    const plain = fingerprintRequestPrefix(base).fingerprint;
    const withSuffix = fingerprintRequestPrefix({ ...base, angleSuffix: ["correctness"] }).fingerprint;
    assert.notEqual(plain, withSuffix);
    // absent angleSuffix stays byte-identical (no spurious fingerprint churn).
    assert.equal(plain, fingerprintRequestPrefix({ ...base }).fingerprint);
  });

  test("non-array tools / contentBlocks fail closed instead of silently dropping the field", () => {
    const base = { model: "m" };
    assert.throws(() => fingerprintRequestPrefix({ ...base, tools: "read" }));
    assert.throws(() => fingerprintRequestPrefix({ ...base, contentBlocks: "x" }));
  });

  test("invalid cacheBoundary / ttlIntent fail closed instead of folding an un-reproducible value", () => {
    const base = { model: "m", tools: ["read"] };
    assert.throws(() => fingerprintRequestPrefix({ ...base, cacheBoundary: "5min" }));
    assert.throws(() => fingerprintRequestPrefix({ ...base, ttlIntent: "5min" }));
    // Valid enum values fold in cleanly.
    assert.match(
      fingerprintRequestPrefix({ ...base, cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: "1h" }).fingerprint,
      /^sha256:[0-9a-f]{64}$/,
    );
  });
});

describe("fingerprintStablePrefix — AC-1: changing only gateState does not change the shared prefix", () => {
  const stablePrefix = "You are a review agent with sys tools.";
  const briefing = "materialized shared briefing block bytes";

  test("returned fingerprint is the stable prefix + briefing only", () => {
    const r = fingerprintStablePrefix({ stablePrefix, briefingBlock: briefing });
    assert.match(r.stableFingerprint, /^sha256:[0-9a-f]{64}$/);
  });

  test("stable fingerprint is identity across gateState-only changes (AC-1)", () => {
    const a = fingerprintStablePrefix({ stablePrefix, briefingBlock: briefing }).stableFingerprint;
    const b = fingerprintStablePrefix({ stablePrefix, briefingBlock: briefing }).stableFingerprint;
    assert.equal(a, b);
  });

  test("changing the briefing changes the stable fingerprint (head-specific bytes matter)", () => {
    const a = fingerprintStablePrefix({ stablePrefix, briefingBlock: briefing }).stableFingerprint;
    const c = fingerprintStablePrefix({ stablePrefix, briefingBlock: briefing + "!" }).stableFingerprint;
    assert.notEqual(a, c);
  });
});

describe("composeCacheAwareRequest — stable/volatile separation (Section B)", () => {
  const stablePrefix = "stable agent/system/tool prefix";
  const briefing = "SHARED_BRIEFING_BLOCK";

  test("cache boundary sits after stable prefix + briefing block, before volatile/angle", () => {
    const r = composeCacheAwareRequest({
      stablePrefix,
      briefingBlock: briefing,
      volatileState: { headSha: "deadbeef", ciStatus: "green", round: 3 },
      angleSuffix: "correctness",
    });
    const slots = r.segments.map((s) => s.slot);
    assert.deepEqual(slots, [
      "stablePrefix",
      "briefingBlock",
      "<cache boundary>",
      "volatileState",
      "angleSuffix",
    ]);
    assert.equal(r.segments[r.boundaryIndex].slot, "<cache boundary>");
  });

  test("no volatile or angle cases keep a minimal 3-segment request", () => {
    const r = composeCacheAwareRequest({ stablePrefix, briefingBlock: briefing });
    assert.deepEqual(r.segments.map((s) => s.slot), ["stablePrefix", "briefingBlock", "<cache boundary>"]);
  });

  test("cache-boundary marker segment is byte-empty (no label leaked into request bytes)", () => {
    const r = composeCacheAwareRequest({ stablePrefix, briefingBlock: briefing });
    const marker = r.segments[r.boundaryIndex];
    assert.equal(marker.slot, "<cache boundary>");
    assert.equal(marker.bytes, "", "boundary label must not be injected into provider-visible prompt bytes");
    // The label still lives in the separate cacheBoundary field.
    assert.equal(r.cacheBoundary, CACHE_BOUNDARY_AFTER_SHARED_PREFIX);
  });

  test("invalid cacheBoundary / ttlIntent fail closed in composeCacheAwareRequest", () => {
    assert.throws(() => composeCacheAwareRequest({ stablePrefix, briefingBlock: briefing, cacheBoundary: "5min" }));
    assert.throws(() => composeCacheAwareRequest({ stablePrefix, briefingBlock: briefing, ttlIntent: "forever" }));
  });

  test("briefedBytes canonicalizes a Buffer stablePrefix (no Buffer.toJSON data array)", () => {
    const r = composeCacheAwareRequest({ stablePrefix: Buffer.from("stable bytes"), briefingBlock: briefing });
    assert.ok(!r.briefedBytes.includes('"type":"Buffer"'), "nested Buffer must not expand into a decimal data array");
    assert.ok(r.briefedBytes.includes("__buffer:"), "nested Buffer canonicalized to a hex marker");
    // Byte-deterministic across identical Buffer bytes.
    assert.equal(
      r.briefedBytes,
      composeCacheAwareRequest({ stablePrefix: Buffer.from("stable bytes"), briefingBlock: briefing }).briefedBytes,
    );
  });

  test("stable fingerprint is unchanged by volatile/angle changes (AC-1 + AC-3)", () => {
    const base = { stablePrefix, briefingBlock: briefing };
    const withVolatile = composeCacheAwareRequest({ ...base, volatileState: { tag: "x" } }).stableFingerprint;
    const withAngle = composeCacheAwareRequest({ ...base, angleSuffix: "security" }).stableFingerprint;
    const plain = composeCacheAwareRequest(base).stableFingerprint;
    assert.equal(withVolatile, plain);
    assert.equal(withAngle, plain);
  });
});

describe("buildReviewDispatchPlan — AC-2: deterministic request-plan artifact", () => {
  const fp = "sha256:" + "a".repeat(64);
  const plan = buildReviewDispatchPlan({
    gate: "pre_approval_gate",
    headSha: "abcdef1234567890",
    sharedPrefixPath: "tmp/gate-context/pre_approval_gate-abcdef1234567890.briefing-prefix.txt",
    sharedPrefixHash: fp,
    requestGroups: [
      { model: "anthropic/claude-opus", requestPrefixFingerprint: fp, cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: "5m", angles: ["correctness", "security"] },
      { model: "anthropic/claude-haiku", requestPrefixFingerprint: fp, ttlIntent: "1h", angles: ["docs"] },
    ],
    capabilities: { harness: "claude" },
  });

  test("records structure without duplicating briefing content", () => {
    assert.equal(plan.gate, "pre_approval_gate");
    assert.equal(plan.headSha, "abcdef1234567890");
    assert.ok(plan.sharedPrefixPath.endsWith("briefing-prefix.txt"));
    assert.equal(plan.requestGroups.length, 2);
    assert.deepEqual(plan.requestGroups[0].angles, ["correctness", "security"]);
    assert.match(plan.planHash, /^sha256:[0-9a-f]{64}$/);
  });

  test("planHash is byte-deterministic", () => {
    const b = buildReviewDispatchPlan({
      gate: "pre_approval_gate",
      headSha: "abcdef1234567890",
      sharedPrefixPath: "tmp/gate-context/pre_approval_gate-abcdef1234567890.briefing-prefix.txt",
      sharedPrefixHash: fp,
      requestGroups: [
        { model: "anthropic/claude-opus", requestPrefixFingerprint: fp, cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: "5m", angles: ["correctness", "security"] },
        { model: "anthropic/claude-haiku", requestPrefixFingerprint: fp, ttlIntent: "1h", angles: ["docs"] },
      ],
      capabilities: { harness: "claude" },
    });
    assert.equal(b.planHash, plan.planHash);
  });

  test("sharedPrefixHash is normalized to canonical sha256:<hex> regardless of caller format", () => {
    const rawHex = "e".repeat(64);
    const prefixed = `sha256:${rawHex}`;
    const withRaw = buildReviewDispatchPlan({ gate: "g", headSha: "abc1234", sharedPrefixHash: rawHex, requestGroups: [] });
    const withPrefixed = buildReviewDispatchPlan({ gate: "g", headSha: "abc1234", sharedPrefixHash: prefixed, requestGroups: [] });
    assert.equal(withRaw.sharedPrefixHash, prefixed);
    assert.equal(withPrefixed.sharedPrefixHash, prefixed);
    // Identical underlying bytes produce an identical plan (no mixed-format drift).
    assert.equal(withRaw.planHash, withPrefixed.planHash);
  });

  test("requestPrefixFingerprint is normalized to canonical sha256:<hex>", () => {
    const rawHex = "f".repeat(64);
    const plan = buildReviewDispatchPlan({
      gate: "g",
      headSha: "abc1234",
      requestGroups: [{ model: "m", requestPrefixFingerprint: rawHex, angles: ["a"] }],
    });
    assert.equal(plan.requestGroups[0].requestPrefixFingerprint, `sha256:${rawHex}`);
  });

  test("extra shadowing a plan key cannot mask a real pinned-field change", () => {
    const base = {
      gate: "pre_approval_gate",
      sharedPrefixPath: "tmp/gate-context/pre_approval_gate-abcdef1234567890.briefing-prefix.txt",
      sharedPrefixHash: fp,
      requestGroups: [
        { model: "anthropic/claude-opus", requestPrefixFingerprint: fp, cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: "5m", angles: ["correctness", "security"] },
        { model: "anthropic/claude-haiku", requestPrefixFingerprint: fp, ttlIntent: "1h", angles: ["docs"] },
      ],
      capabilities: { harness: "claude" },
    };
    // Two plans that differ in their REAL headSha but carry the SAME opacity
    // shadowing extra. Under the old {...plan, ...extra} fold, the extra's
    // shadowed headSha would mask the real difference and both would hash
    // identically; the fingerprint must pin the plan's actual values instead.
    const a = buildReviewDispatchPlan({ ...base, headSha: "aaaa1111111111111111111111111111111111", extra: { headSha: "bbbb2222222222222222222222222222222222", gate: "draft_gate" } });
    const b = buildReviewDispatchPlan({ ...base, headSha: "bbbb2222222222222222222222222222222222", extra: { headSha: "bbbb2222222222222222222222222222222222", gate: "draft_gate" } });
    assert.notEqual(a.planHash, b.planHash, "extra shadowing must not mask a real headSha change");
    // The returned plan still carries the REAL values, not the extra's.
    assert.equal(a.headSha, "aaaa1111111111111111111111111111111111");
    assert.equal(b.headSha, "bbbb2222222222222222222222222222222222");
    assert.equal(a.gate, "pre_approval_gate");
    assert.equal(b.gate, "pre_approval_gate");
  });

  test("distinct opaque extra still diverges the fingerprint", () => {
    const base = {
      gate: "pre_approval_gate",
      headSha: "abcdef1234567890",
      sharedPrefixPath: "tmp/gate-context/pre_approval_gate-abcdef1234567890.briefing-prefix.txt",
      sharedPrefixHash: fp,
      requestGroups: [
        { model: "anthropic/claude-opus", requestPrefixFingerprint: fp, cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: "5m", angles: ["correctness", "security"] },
        { model: "anthropic/claude-haiku", requestPrefixFingerprint: fp, ttlIntent: "1h", angles: ["docs"] },
      ],
      capabilities: { harness: "claude" },
    };
    const a = buildReviewDispatchPlan({ ...base, extra: { reportParseCue: "alpha" } });
    const b = buildReviewDispatchPlan({ ...base, extra: { reportParseCue: "beta" } });
    assert.notEqual(a.planHash, b.planHash);
    assert.notEqual(a.planHash, plan.planHash);
  });

  test("usages fail closed on bad input", () => {
    assert.throws(() => buildReviewDispatchPlan({ gate: "", headSha: "abc" }));
    assert.throws(() => buildReviewDispatchPlan({ gate: "g", headSha: "not-a-sha" }));
    assert.throws(() => buildReviewDispatchPlan({ gate: "g", headSha: "abc", sharedPrefixHash: "nope" }));
    assert.throws(() =>
      buildReviewDispatchPlan({
        gate: "g",
        headSha: "abc",
        requestGroups: [{ model: "m", angles: [] }],
      }),
    );
  });

  test("validateRequestGroups fail-closed branches (full negative coverage)", () => {
    assert.throws(() => buildReviewDispatchPlan({ gate: "g", headSha: "abc", requestGroups: "nope" }));
    assert.throws(() =>
      buildReviewDispatchPlan({ gate: "g", headSha: "abc", requestGroups: [{ model: "", angles: ["a"] }] }),
    );
    assert.throws(() =>
      buildReviewDispatchPlan({
        gate: "g",
        headSha: "abc",
        requestGroups: [{ model: "m", requestPrefixFingerprint: "not-hex", angles: ["a"] }],
      }),
    );
    assert.throws(() =>
      buildReviewDispatchPlan({
        gate: "g",
        headSha: "abc",
        requestGroups: [{ model: "m", cacheBoundary: "never", angles: ["a"] }],
      }),
    );
    assert.throws(() =>
      buildReviewDispatchPlan({
        gate: "g",
        headSha: "abc",
        requestGroups: [{ model: "m", ttlIntent: "forever", angles: ["a"] }],
      }),
    );
  });
});

describe("resolvePrimerForm — default by harness capability (Section C/AC-6)", () => {
  test("completion_only + fixed TTL (no adequate declared TTL) -> dedicated primer", () => {
    const caps = normalizeHarnessCapabilities({ harness: "claude" });
    const r = resolvePrimerForm({ capabilities: caps, ttlIntent: "5m" });
    assert.equal(r.primerForm, PRIMER_FORM_DEDICATED);
  });

  test("completion_only + 5m_1h TTL + explicit 1h intent -> lead reviewer may prime", () => {
    const caps = normalizeHarnessCapabilities({
      capabilities: { barrierSignal: "completion_only", cacheTtlControl: "5m_1h", breakpointControl: "explicit", usageTelemetry: "available" },
    });
    const r = resolvePrimerForm({ capabilities: caps, ttlIntent: "1h" });
    assert.equal(r.primerForm, PRIMER_FORM_LEAD_REVIEWER);
  });

  test("first_output + adequate TTL -> lead reviewer", () => {
    const caps = normalizeHarnessCapabilities({
      capabilities: { barrierSignal: "first_output", cacheTtlControl: "5m_1h", breakpointControl: "explicit", usageTelemetry: "available" },
    });
    assert.equal(resolvePrimerForm({ capabilities: caps, ttlIntent: "5m" }).primerForm, PRIMER_FORM_LEAD_REVIEWER);
  });

  test("pi opaque posture defaults to dedicated primer (cannot observe barrier)", () => {
    const caps = normalizeHarnessCapabilities({ harness: "pi" });
    assert.equal(resolvePrimerForm({ capabilities: caps }).primerForm, PRIMER_FORM_DEDICATED);
  });

  test("first_output + 5m_1h TTL control + no adequate declared ttlIntent -> lead reviewer (second disjunct)", () => {
    const caps = normalizeHarnessCapabilities({
      capabilities: { barrierSignal: "first_output", cacheTtlControl: "5m_1h", breakpointControl: "explicit", usageTelemetry: "available" },
    });
    assert.equal(
      resolvePrimerForm({ capabilities: caps, ttlIntent: "harness_managed" }).primerForm,
      PRIMER_FORM_LEAD_REVIEWER,
    );
  });
});

describe("partitionPrimerGroups — one primer group per model/request-prefix (Section C)", () => {
  test("distinct models -> distinct groups, never cross-warmed", () => {
    const fp = "sha256:" + "b".repeat(64);
    const groups = partitionPrimerGroups(
      [
        { model: "m1", requestPrefixFingerprint: fp, angles: ["a"], ttlIntent: "5m" },
        { model: "m2", requestPrefixFingerprint: fp, angles: ["b"], ttlIntent: "5m" },
      ],
      normalizeHarnessCapabilities({ harness: "claude" }),
    );
    assert.equal(groups.length, 2);
    assert.notEqual(groups[0].model, groups[1].model);
  });

  test("two groups resolving to the same model/prefix collapse to one primer group", () => {
    const fp = "sha256:" + "c".repeat(64);
    const groups = partitionPrimerGroups([
      { model: "m1", requestPrefixFingerprint: fp, angles: ["a"], ttlIntent: "5m" },
      { model: "m1", requestPrefixFingerprint: fp, angles: ["b"], ttlIntent: "5m" },
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual([...groups[0].groups.flatMap((g) => g.angles)], ["a", "b"]);
  });

  test("model id containing '::' is not truncated by partition key parsing", () => {
    const fp = "sha256:" + "d".repeat(64);
    const groups = partitionPrimerGroups([
      { model: "a::b:c", requestPrefixFingerprint: fp, angles: ["a"], ttlIntent: "5m" },
      { model: "a::b:c", requestPrefixFingerprint: fp, angles: ["b"], ttlIntent: "5m" },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].model, "a::b:c");
    assert.equal(groups[0].requestPrefixFingerprint, fp);
  });

  test("collapsed groups with mixed TTL intents take the conservative dedicated primer", () => {
    const foFixed = normalizeHarnessCapabilities({
      capabilities: { barrierSignal: "first_output", cacheTtlControl: "fixed", breakpointControl: "explicit", usageTelemetry: "available" },
    });
    const fp = "sha256:" + "e".repeat(64);
    // 5m -> lead; harness_managed -> dedicated under fixed TTL control.
    const groups = partitionPrimerGroups([
      { model: "m", requestPrefixFingerprint: fp, angles: ["a"], ttlIntent: "5m" },
      { model: "m", requestPrefixFingerprint: fp, angles: ["b"], ttlIntent: "harness_managed" },
    ], foFixed);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].primerForm, PRIMER_FORM_DEDICATED);
  });

  test("collapsed groups all with adequate TTL -> lead reviewer primer", () => {
    const foFixed = normalizeHarnessCapabilities({
      capabilities: { barrierSignal: "first_output", cacheTtlControl: "fixed", breakpointControl: "explicit", usageTelemetry: "available" },
    });
    const fp = "sha256:" + "f".repeat(64);
    const groups = partitionPrimerGroups([
      { model: "m", requestPrefixFingerprint: fp, angles: ["a"], ttlIntent: "1h" },
      { model: "m", requestPrefixFingerprint: fp, angles: ["b"], ttlIntent: "5m" },
    ], foFixed);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].primerForm, PRIMER_FORM_LEAD_REVIEWER);
  });

  test("groups lacking a requestPrefixFingerprint are NOT collapsed (fail-closed)", () => {
    const groups = partitionPrimerGroups([
      { model: "m", angles: ["a"], ttlIntent: "5m" },
      { model: "m", angles: ["b"], ttlIntent: "5m" },
      { model: "other", angles: ["c"], ttlIntent: "5m" },
    ]);
    // Each fingerprint-less group forms its own partition — without a proven
    // prefix, two 'm' groups cannot be shown to share a cache-relevant prefix,
    // so merging them would let one primer silently cover unknown prefixes.
    assert.equal(groups.length, 3);
    const mGroups = groups.filter((g) => g.model === "m");
    assert.equal(mGroups.length, 2);
    for (const g of groups) assert.equal(g.requestPrefixFingerprint, null);
    assert.deepEqual([...mGroups.map((g) => g.groups[0].angles[0])].sort(), ["a", "b"]);
  });
});

describe("sha256Hex — deterministic hashing + opaque markers", () => {
  test("sha256Hex produces sha256:<64 hex> for a string", () => {
    assert.match(sha256Hex("x"), /^sha256:[0-9a-f]{64}$/);
  });

  test("sha256Hex is byte-deterministic across object key order", () => {
    const a = sha256Hex({ b: 1, a: 2 });
    const b = sha256Hex({ a: 2, b: 1 });
    assert.equal(a, b);
  });

  test("opaqueMarker marks harness-owned values as unverifiable", () => {
    assert.match(opaqueMarker("model"), /^__opaque:/);
  });

  test("nested Buffers are canonicalized to hex (not Buffer.toJSON data array)", () => {
    const a = sha256Hex({ bytes: Buffer.from("hello"), label: "x" });
    // Same bytes reconstructed identically -> identical hash (memory vs disk).
    assert.equal(a, sha256Hex({ bytes: Buffer.from("hello"), label: "x" }));
    // A Buffer and an identical hex string must NOT collide (prefix disambiguates).
    assert.notEqual(a, sha256Hex({ bytes: "hello", label: "x" }));
  });
});
