import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  CACHE_TELEMETRY_SCHEMA_VERSION,
  buildCacheTelemetryEvidence,
  cacheTelemetryPath,
  enforceCacheTelemetryEvidence,
  validateCacheTelemetryEvidence,
  writeCacheTelemetryEvidence,
} from "../src/loop/cache-telemetry-evidence.mjs";
import {
  CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
  buildReviewDispatchPlan,
} from "../src/loop/review-dispatch-plan.mjs";

const fp = "sha256:" + "a".repeat(64);

function makePlan({ capabilities } = {}) {
  return buildReviewDispatchPlan({
    gate: "pre_approval_gate",
    headSha: "abcdef1234567890",
    sharedPrefixHash: fp,
    requestGroups: [
      { model: "model-a", requestPrefixFingerprint: fp, cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: "1h", angles: ["correctness", "security"] },
    ],
    capabilities,
  });
}

// A telemetry-capable harness (Section D: usageTelemetry=available) with one
// cache creation and a multi-reviewer read group — the adapter-test analogue of
// "one cache creation followed by cache reads for a multi-reviewer group".
const claudePlan = () =>
  makePlan({ capabilities: { harness: "claude" } });

// An opaque harness (Section D: usageTelemetry=unavailable) — must NEVER be
// described as a verified 1-write-N-reads result.
const piPlan = () =>
  makePlan({ capabilities: { harness: "pi" } });

describe("cacheTelemetryPath — deterministic artifact path (AC-1)", () => {
  test("derives a stable, gate+head-scoped path under a given dir", () => {
    const p = cacheTelemetryPath({ dir: "tmp/gate-context", gate: "pre_approval_gate", headSha: "abcdef1234567890" });
    assert.match(p, /^tmp\/gate-context\/pre_approval_gate-abcdef1234567890\.cache-telemetry\.json$/);
    // Deterministic: same input -> same path.
    assert.equal(
      p,
      cacheTelemetryPath({ dir: "tmp/gate-context", gate: "pre_approval_gate", headSha: "abcdef1234567890" }),
    );
  });

  test("fails closed on missing gate/headSha", () => {
    assert.throws(() => cacheTelemetryPath({ dir: "d", headSha: "abc" }));
    assert.throws(() => cacheTelemetryPath({ dir: "d", gate: "g" }));
  });

  test("fails closed on a malformed (non-hex / wrong-length) headSha", () => {
    assert.throws(() => cacheTelemetryPath({ dir: "d", gate: "g", headSha: "not-hex-sh" }));
    assert.throws(() => cacheTelemetryPath({ dir: "d", gate: "g", headSha: "abc" })); // < 7 chars
  });
});

describe("buildCacheTelemetryEvidence — telemetry-capable harness records create+reads", () => {
  test("records one creation + N reads and an aggregate read:create report (verified)", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [
        { model: "model-a", primerForm: "lead_reviewer", tokens: 12000 },
      ],
      reviewerCacheReads: [
        { model: "model-a", angle: "correctness", tokens: 200 },
        { model: "model-a", angle: "security", tokens: 210 },
      ],
    });
    assert.equal(ev.schemaVersion, CACHE_TELEMETRY_SCHEMA_VERSION);
    assert.equal(ev.telemetryAvailable, true);
    assert.equal(ev.cacheReuseVerified, true);
    assert.equal(ev.creationCount, 1);
    assert.equal(ev.readCount, 2);
    assert.equal(ev.creationTokens, 12000);
    assert.equal(ev.readTokens, 410);
    assert.equal(ev.aggregate.creates, 1);
    assert.equal(ev.aggregate.reads, 2);
    assert.equal(ev.aggregate.readToCreateRatio, 2);
    assert.equal(ev.aggregate.measured, true);
    assert.match(ev.aggregate.report, /verified 2 cache reads after 1 cache creation/);
    // Deterministic binding to the plan.
    assert.equal(ev.planHash, claudePlan().planHash);
    assert.equal(ev.sharedPrefixHash, fp);
  });

  test("fails validation if nothing observed even when telemetry-capable", () => {
    // Telemetry available but NO create/read events measured: cannot claim
    // verified reuse (measurement is empty).
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [],
      reviewerCacheReads: [],
    });
    assert.equal(ev.cacheReuseVerified, false);
    assert.match(ev.aggregate.report, /provider reuse could not be verified/);
  });
});

describe("buildCacheTelemetryEvidence — opaque harness never claims verified reuse", () => {
  test("opaque/unavailable telemetry forces cacheReuseVerified=false", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: piPlan(),
      primerCacheCreations: [{ model: "model-a", primerForm: "dedicated_primer", tokens: null }],
      reviewerCacheReads: [
        { model: "model-a", angle: "correctness", tokens: null },
        { model: "model-a", angle: "security", tokens: null },
      ],
    });
    assert.equal(ev.telemetryAvailable, false);
    assert.equal(ev.cacheReuseVerified, false);
    assert.match(ev.aggregate.report, /provider reuse could not be verified/);
    assert.match(ev.aggregate.report, /usageTelemetry=unavailable/);
    assert.doesNotMatch(ev.aggregate.report, /verified 1 write/);
    assert.doesNotMatch(ev.aggregate.report, /verified 2 cache reads/);
  });

  test("a plan without any capability record also fails closed", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: makePlan({ capabilities: undefined }),
      primerCacheCreations: [{ model: "model-a" }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness" }],
    });
    assert.equal(ev.capabilities, null);
    assert.equal(ev.cacheReuseVerified, false);
    assert.match(ev.aggregate.report, /could not be verified/);
  });

  test("fails closed on a non-numeric token value (no silent coercion)", () => {
    const plan = claudePlan();
    assert.throws(
      () =>
        buildCacheTelemetryEvidence({
          plan,
          primerCacheCreations: [{ model: "model-a", tokens: "12000" }],
          reviewerCacheReads: [{ model: "model-a", angle: "correctness", tokens: 200 }],
        }),
      /tokens must be a finite non-negative number or null/,
    );
    assert.throws(
      () =>
        buildCacheTelemetryEvidence({
          plan,
          primerCacheCreations: [{ model: "model-a", tokens: -5 }],
          reviewerCacheReads: [],
        }),
      /tokens must be a finite non-negative number or null/,
    );
  });

  test("fails closed on a null/entry with empty model (nil-entry guard)", () => {
    const plan = claudePlan();
    assert.throws(
      () =>
        buildCacheTelemetryEvidence({
          plan,
          primerCacheCreations: [null],
          reviewerCacheReads: [],
        }),
      /must be an object with a non-empty concrete model/,
    );
    assert.throws(
      () =>
        buildCacheTelemetryEvidence({
          plan,
          primerCacheCreations: [{ model: "" }],
          reviewerCacheReads: [],
        }),
      /must be an object with a non-empty concrete model/,
    );
  });

  test("fails closed on a missing requestGroups plan / non-array event lists", () => {
    assert.throws(() => buildCacheTelemetryEvidence({ plan: {} }), /plan with requestGroups/);
    assert.throws(
      () => buildCacheTelemetryEvidence({ plan: { gate: "g", headSha: "abcdef1234", planHash: "h" } }),
      /plan with requestGroups/,
    );
    const anyway = { requestGroups: [{ model: "model-a" }] };
    // Each new build-time guard fires independently on an otherwise-valid plan.
    assert.throws(
      () => buildCacheTelemetryEvidence({ plan: { ...anyway, gate: "" } }),
      /non-empty gate/,
    );
    assert.throws(
      () => buildCacheTelemetryEvidence({ plan: { ...anyway, gate: "g", headSha: "zz!" } }),
      /hex headSha/,
    );
    assert.throws(
      () =>
        buildCacheTelemetryEvidence({ plan: { ...anyway, gate: "g", headSha: "abcdef1234", planHash: "" } }),
      /non-empty planHash/,
    );
    const plan = claudePlan();
    assert.throws(
      () => buildCacheTelemetryEvidence({ plan, primerCacheCreations: "nope" }),
      /primerCacheCreations must be an array/,
    );
    assert.throws(
      () => buildCacheTelemetryEvidence({ plan, reviewerCacheReads: "nope" }),
      /reviewerCacheReads must be an array/,
    );
  });
});

describe("validateCacheTelemetryEvidence — fail-closed honesty gate", () => {
  test("passes a valid telemetry-capable artifact", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [
        { model: "model-a", angle: "correctness", tokens: 200 },
        { model: "model-a", angle: "security", tokens: 210 },
      ],
    });
    const r = validateCacheTelemetryEvidence({ evidence: ev });
    assert.equal(r.ok, true);
    assert.deepEqual(r.failures, []);
  });

  test("fails closed on a claimed-verified result with unavailable telemetry", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: piPlan(),
      primerCacheCreations: [{ model: "model-a" }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness" }],
    });
    // Mutate the honest verdict to simulate a code path trying to over-claim.
    const subverted = { ...ev, telemetryAvailable: false, cacheReuseVerified: true };
    const r = validateCacheTelemetryEvidence({ evidence: subverted });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "opaque_veracity"));
  });

  test("fails closed even when BOTH cacheReuseVerified and telemetryAvailable are flipped (re-derived from capabilities)", () => {
    // The honesty gate must be driven by evidence.capabilities.usageTelemetry,
    // not the stored telemetryAvailable boolean: flipping both booleans on an
    // opaque (pi) artifact must still fail closed.
    const ev = buildCacheTelemetryEvidence({
      plan: piPlan(),
      primerCacheCreations: [{ model: "model-a" }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness" }],
    });
    const subverted = { ...ev, telemetryAvailable: true, cacheReuseVerified: true };
    const r = validateCacheTelemetryEvidence({ evidence: subverted });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "opaque_veracity"));
  });

  test("fails closed on a tampered aggregate report (aggregate_consistency)", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness", tokens: 200 }],
    });
    // Forge a readToCreateRatio that contradicts the counts.
    const subverted = { ...ev, aggregate: { ...ev.aggregate, readToCreateRatio: 99 } };
    const r = validateCacheTelemetryEvidence({ evidence: subverted });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "aggregate_consistency"));
  });

  test("fails closed on a tampered token aggregate (token_aggregate)", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness", tokens: 200 }],
    });
    const subverted = { ...ev, creationTokens: 1 };
    const r = validateCacheTelemetryEvidence({ evidence: subverted });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "token_aggregate"));
  });

  test("fails closed on a structurally incomplete artifact (missing identity fields)", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness", tokens: 200 }],
    });
    // Drop the identity fields while keeping the event arrays/aggregates
    // self-consistent — the artifact must still fail closed on the missing
    // round identity rather than pass as valid evidence.
    const { gate, headSha, planHash, schemaVersion, ...incomplete } = ev;
    const r = validateCacheTelemetryEvidence({ evidence: incomplete });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "identity_field"));
  });

  test("fails closed on a missing capability record (capability_record)", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness", tokens: 200 }],
    });
    const subverted = { ...ev, capabilities: null };
    const r = validateCacheTelemetryEvidence({ evidence: subverted });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "capability_record"));
  });

  test("fails closed when verified reuse lacks a measured create-then-read sequence", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [],
      reviewerCacheReads: [],
    });
    const subverted = { ...ev, cacheReuseVerified: true };
    const r = validateCacheTelemetryEvidence({ evidence: subverted });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "measured_sequence"));
  });

  test("fails closed on a missing artifact", () => {
    const r = validateCacheTelemetryEvidence({ evidence: null });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "artifact"));
  });

  test("returns structured failures (never throws) on a truthy non-array events field", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness", tokens: 200 }],
    });
    // Both events fields get the same truthy non-array treatment (the symmetric
    // reviewerCacheReads arm and its safe-array fallback must not throw either).
    for (const bad of ["abc", { a: 1 }, 5]) {
      for (const [field, label] of [
        ["primerCacheCreations", "primerCacheCreations"],
        ["reviewerCacheReads", "reviewerCacheReads"],
      ]) {
        const subverted = { ...ev, [field]: bad };
        assert.doesNotThrow(() => validateCacheTelemetryEvidence({ evidence: subverted }));
        const r = validateCacheTelemetryEvidence({ evidence: subverted });
        assert.equal(r.ok, false);
        assert.ok(
          r.failures.some((f) => f.check === "aggregate_consistency"),
          `${label} non-array should yield an aggregate_consistency failure`,
        );
      }
    }
  });

  test("returns structured failures (never throws) on null/non-object array elements", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness", tokens: 200 }],
    });
    for (const bad of [[null], ["x"], [null, { model: "model-a", tokens: 5 }]]) {
      const subverted = { ...ev, primerCacheCreations: bad, creationCount: bad.length };
      assert.doesNotThrow(() => validateCacheTelemetryEvidence({ evidence: subverted }));
      const r = validateCacheTelemetryEvidence({ evidence: subverted });
      assert.equal(r.ok, false);
    }
  });

  test("fails closed on report prose contradicting cacheReuseVerified", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness", tokens: 200 }],
    });
    // Report claims "verified ... cache read" while machine verdict stays false.
    const subverted = {
      ...ev,
      cacheReuseVerified: false,
      aggregate: { ...ev.aggregate, report: "verified 1 cache read after 1 cache creation" },
    };
    const r = validateCacheTelemetryEvidence({ evidence: subverted });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "aggregate_consistency"));
  });
});

describe("enforceCacheTelemetryEvidence — strict refusal surface", () => {
  test("returns true for valid evidence", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness", tokens: 200 }],
    });
    assert.equal(enforceCacheTelemetryEvidence({ evidence: ev }), true);
  });

  test("throws naming GATE-EXEC-CACHE-TELEMETRY for an over-claim", () => {
    const ev = buildCacheTelemetryEvidence({
      plan: piPlan(),
      primerCacheCreations: [{ model: "model-a" }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness" }],
    });
    assert.throws(
      () => enforceCacheTelemetryEvidence({ evidence: { ...ev, cacheReuseVerified: true } }),
      /GATE-EXEC-CACHE-TELEMETRY/,
    );
  });
});

describe("writeCacheTelemetryEvidence — deterministic persistence", () => {
  test("two identical builds produce byte-identical artifacts (content determinism)", () => {
    const a = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [
        { model: "model-a", angle: "correctness", tokens: 200 },
        { model: "model-a", angle: "security", tokens: 210 },
      ],
    });
    const b = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [
        { model: "model-a", angle: "correctness", tokens: 200 },
        { model: "model-a", angle: "security", tokens: 210 },
      ],
    });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.deepEqual(a, b);
  });

  test("writes the artifact to its deterministic path", async () => {
    const ev = buildCacheTelemetryEvidence({
      plan: claudePlan(),
      primerCacheCreations: [{ model: "model-a", tokens: 12000 }],
      reviewerCacheReads: [{ model: "model-a", angle: "correctness", tokens: 200 }],
    });
    const { rm } = await import("node:fs/promises");
    const { path: target } = await writeCacheTelemetryEvidence({ dir: "tmp/cache-telemetry-test", evidence: ev });
    assert.match(target, /cache-telemetry\.json$/);
    const onDisk = JSON.parse(await readTestFile(target));
    assert.equal(onDisk.cacheReuseVerified, true);
    assert.equal(onDisk.aggregate.reads, 1);
    await rm("tmp/cache-telemetry-test", { recursive: true, force: true });
  });
});

async function readTestFile(p) {
  const { readFile } = await import("node:fs/promises");
  return readFile(p, "utf8");
}
