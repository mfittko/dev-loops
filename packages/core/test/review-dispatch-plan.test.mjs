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
});
