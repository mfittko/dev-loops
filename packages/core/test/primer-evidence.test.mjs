import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  PRIMER_EVIDENCE_SCHEMA_VERSION,
  buildPrimerEvidence,
  enforcePrimerEvidence,
  primerEvidencePath,
  validatePrimerEvidence,
} from "../src/loop/primer-evidence.mjs";
import {
  CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
  PRIMER_FORM_DEDICATED,
  PRIMER_FORM_LEAD_REVIEWER,
  buildReviewDispatchPlan,
  partitionPrimerGroups,
} from "../src/loop/review-dispatch-plan.mjs";

const fp = "sha256:" + "a".repeat(64);
const fp2 = "sha256:" + "b".repeat(64);

function makePlan({ groups } = {}) {
  return buildReviewDispatchPlan({
    gate: "pre_approval_gate",
    headSha: "abcdef1234567890",
    sharedPrefixHash: fp,
    requestGroups: groups ?? [
      { model: "model-a", requestPrefixFingerprint: fp, cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: "1h", angles: ["correctness", "security"] },
    ],
    capabilities: { harness: "claude" },
  });
}

describe("primerEvidencePath — deterministic artifact path (AC-1)", () => {
  test("derives a stable, gate+head-scoped path under a given dir", () => {
    const p = primerEvidencePath({ dir: "tmp/gate-context", gate: "pre_approval_gate", headSha: "abcdef1234567890" });
    assert.match(p, /^tmp\/gate-context\/pre_approval_gate-abcdef1234567890\.primer-evidence\.json$/);
    // Deterministic: same input -> same path.
    assert.equal(
      p,
      primerEvidencePath({ dir: "tmp/gate-context", gate: "pre_approval_gate", headSha: "abcdef1234567890" }),
    );
  });

  test("fails closed on missing gate/headSha", () => {
    assert.throws(() => primerEvidencePath({ dir: "d", headSha: "abc" }));
    assert.throws(() => primerEvidencePath({ dir: "d", gate: "g" }));
  });
});

describe("buildPrimerEvidence — ordering evidence record (AC-1/AC-2)", () => {
  test("records planHash, sharedPrefixHash, gate, headSha and primer runs", () => {
    const plan = makePlan();
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [
        { model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 },
      ],
      reviewerReleases: [
        { model: "model-a", requestPrefixFingerprint: fp, releasedAt: 11 },
      ],
      capabilities: { harness: "claude" },
    });
    assert.equal(ev.schemaVersion, PRIMER_EVIDENCE_SCHEMA_VERSION);
    assert.equal(ev.gate, "pre_approval_gate");
    assert.equal(ev.headSha, "abcdef1234567890");
    assert.equal(ev.planHash, plan.planHash);
    assert.equal(ev.sharedPrefixHash, fp);
  });

  test("two request groups resolving to different concrete models produce two primer runs, each scoped to its own model/prefix", () => {
    const plan = makePlan({
      groups: [
        { model: "model-a", requestPrefixFingerprint: fp, angles: ["correctness"] },
        { model: "model-b", requestPrefixFingerprint: fp2, angles: ["security"] },
      ],
    });
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [
        { model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_DEDICATED, landedAt: 5 },
        { model: "model-b", requestPrefixFingerprint: fp2, primerForm: PRIMER_FORM_DEDICATED, landedAt: 6 },
      ],
      reviewerReleases: [
        { model: "model-a", requestPrefixFingerprint: fp, releasedAt: 20 },
        { model: "model-b", requestPrefixFingerprint: fp2, releasedAt: 21 },
      ],
      capabilities: { harness: "pi" },
    });
    assert.equal(ev.primerRuns.length, 2);
    // Neither primer is credited to the other's group: model-a's run carries
    // model-a's prefix, model-b's carries model-b's.
    const a = ev.primerRuns.find((r) => r.model === "model-a");
    const b = ev.primerRuns.find((r) => r.model === "model-b");
    assert.equal(a.requestPrefixFingerprint, fp);
    assert.equal(b.requestPrefixFingerprint, fp2);
  });

  test("fails closed when a run references a model not present in the plan's request groups", () => {
    const plan = makePlan();
    assert.throws(() =>
      buildPrimerEvidence({
        plan,
        primerRuns: [{ model: "ghost", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_DEDICATED, landedAt: 5 }],
        reviewerReleases: [],
      }),
    );
  });
});

describe("validatePrimerEvidence — fail-closed fan-in gate (AC-3)", () => {
  function validEvidence() {
    const plan = makePlan();
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
      reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: fp, releasedAt: 11 }],
      capabilities: { harness: "claude" },
    });
    return { plan, ev };
  }

  test("clean evidence validates ok with no failures", () => {
    const { plan, ev } = validEvidence();
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, true);
    assert.equal(r.failures.length, 0);
  });

  test("fails closed (order) when a reviewer was released before its primer landed", () => {
    const plan = makePlan();
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
      reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: fp, releasedAt: 5 }], // before primer landed 10
    });
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "primer_order" && /before.*primer/.test(f.reason)));
  });

  test("fails closed (model group) when a reviewer is released under a model with no primer run", () => {
    const plan = makePlan();
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
      reviewerReleases: [
        { model: "model-a", requestPrefixFingerprint: fp, releasedAt: 11 },
        { model: "model-a", requestPrefixFingerprint: "sha256:" + "c".repeat(64), releasedAt: 12 },
      ],
    });
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "model_group"));
  });

  test("fails closed (request fingerprint) when a primer's prefix does not match the plan's group", () => {
    const plan = makePlan();
    // Validate the request_fingerprint branch with a hand-shaped evidence literal
    // (build() already fails closed on the same condition, but the validator must
    // also reject a hand-edited/legacy artifact that references an unknown prefix).
    const raw = {
      schemaVersion: 1,
      gate: plan.gate,
      headSha: plan.headSha,
      planHash: plan.planHash,
      sharedPrefixHash: plan.sharedPrefixHash,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: "sha256:" + "e".repeat(64), primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
      reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: fp, releasedAt: 11 }],
    };
    const r = validatePrimerEvidence({ plan, evidence: raw });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "request_fingerprint"));
  });

  test("fails closed (shared-prefix hash) when evidence sharedPrefixHash mismatches plan", () => {
    const plan = makePlan();
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
      reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: fp, releasedAt: 11 }],
    });
    // Evidence built from the plan inherits the plan's hash; force a mismatch by
    // re-deriving against a different shared prefix and overriding.
    const mismatched = { ...ev, sharedPrefixHash: "sha256:" + "f".repeat(64) };
    const r = validatePrimerEvidence({ plan, evidence: mismatched });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "shared_prefix_hash"));
  });

  test("fails closed when a request group from the plan has no primer run at all", () => {
    const plan = makePlan({
      groups: [
        { model: "model-a", requestPrefixFingerprint: fp, angles: ["correctness"] },
        { model: "model-b", requestPrefixFingerprint: fp2, angles: ["security"] },
      ],
    });
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [
        { model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_DEDICATED, landedAt: 5 },
        // model-b has NO primer run -> group coverage failure
      ],
      reviewerReleases: [
        { model: "model-a", requestPrefixFingerprint: fp, releasedAt: 20 },
      ],
    });
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "group_coverage"));
  });

  test("partition-derived evidence from two models validates with two distinct primers (AC-2 end-to-end)", () => {
    const plan = buildReviewDispatchPlan({
      gate: "pre_approval_gate",
      headSha: "abcdef1234567890",
      sharedPrefixHash: fp,
      requestGroups: [
        { model: "model-a", requestPrefixFingerprint: fp, angles: ["correctness"] },
        { model: "model-b", requestPrefixFingerprint: fp2, angles: ["security"] },
      ],
      capabilities: { harness: "pi" },
    });
    const partitions = partitionPrimerGroups(plan.requestGroups);
    assert.equal(partitions.length, 2);
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: partitions.map((p, i) => ({
        model: p.model,
        requestPrefixFingerprint: p.requestPrefixFingerprint,
        primerForm: p.primerForm,
        landedAt: 10 + i,
      })),
      reviewerReleases: partitions.map((p, i) => ({
        model: p.model,
        requestPrefixFingerprint: p.requestPrefixFingerprint,
        releasedAt: 100 + i,
      })),
    });
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, true);
    assert.ok(ev.primerRuns.length === 2);
  });
});

describe("enforcePrimerEvidence — strict fail-closed refusal surface (GATE-EXEC-PRIMER-EVIDENCE)", () => {
  test("clean evidence resolves to true", () => {
    const plan = makePlan();
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
      reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: fp, releasedAt: 11 }],
    });
    assert.equal(enforcePrimerEvidence({ plan, evidence: ev }), true);
  });

  test("invalid evidence throws a refusal naming the failing check", () => {
    const plan = makePlan();
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
      reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: fp, releasedAt: 5 }], // before primer
    });
    assert.throws(
      () => enforcePrimerEvidence({ plan, evidence: ev }),
      /GATE-EXEC-PRIMER-EVIDENCE.*primer_order/,
    );
  });
});

describe("fingerprint-less request groups — stable per-model ordinal keying (unkeyed edge path)", () => {
  // Regression for the unkeyed-key drift: buildPrimerEvidence keyed
  // fingerprint-less runs by their ARRAY index while planGroupIndex keyed
  // plan groups by their PLAN index, so a fingerprint-less run whose array
  // position differed from its group's plan position threw a false
  // "prefix not present" error; validatePrimerEvidence keyed them with no
  // index at all. Both now use the same per-model ordinal scheme.
  test("a fingerprint-less group + run validates clean (no false prefix error)", () => {
    const plan = makePlan({
      groups: [
        {
          model: "model-a",
          requestPrefixFingerprint: null,
          cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
          ttlIntent: "1h",
          angles: ["correctness", "security"],
        },
        {
          model: "model-b",
          requestPrefixFingerprint: fp2,
          cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
          ttlIntent: "1h",
          angles: ["scope"],
        },
      ],
    });
    // The fingerprint-less run is at array index 1, the fingerprint-keyed
    // run at index 0 — the wrong-order case that previously false-threw.
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [
        { model: "model-b", requestPrefixFingerprint: fp2, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 3 },
        { model: "model-a", primerForm: PRIMER_FORM_DEDICATED, landedAt: 1 },
      ],
      reviewerReleases: [
        { model: "model-a", releasedAt: 2 },
        { model: "model-b", requestPrefixFingerprint: fp2, releasedAt: 4 },
      ],
    });
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
    assert.equal(enforcePrimerEvidence({ plan, evidence: ev }), true);
  });

  test("a fingerprint-less group with no primer run fails closed on group_coverage", () => {
    const plan = makePlan({
      groups: [
        {
          model: "model-a",
          requestPrefixFingerprint: null,
          cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
          ttlIntent: "1h",
          angles: ["correctness", "security"],
        },
      ],
    });
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [],
      reviewerReleases: [{ model: "model-a", releasedAt: 5 }],
    });
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "group_coverage"));
    assert.throws(
      () => enforcePrimerEvidence({ plan, evidence: ev }),
      /group_coverage/,
    );
  });
});

describe("draft-gate hardening of validatePrimerEvidence (fan-in converge findings)", () => {
  test("shared_prefix_hash passes when BOTH plan and evidence omit a shared prefix (no false-positive)", () => {
    const plan = buildReviewDispatchPlan({
      gate: "pre_approval_gate",
      headSha: "abcdef1234567890",
      // deliberately NO sharedPrefixHash
      requestGroups: [
        { model: "model-a", requestPrefixFingerprint: fp, cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: "1h", angles: ["scope"] },
      ],
      capabilities: { harness: "claude" },
    });
    assert.equal(plan.sharedPrefixHash == null, true); // buildReviewDispatchPlan omits the key when absent
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
      reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: fp, releasedAt: 11 }],
    });
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, true, JSON.stringify(r.failures));
  });

  test("plan_hash fails closed when evidence planHash is missing (tampered/truncated evidence)", () => {
    const plan = makePlan();
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
      reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: fp, releasedAt: 11 }],
    });
    const stripped = { ...ev, planHash: null };
    const r = validatePrimerEvidence({ plan, evidence: stripped });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "plan_hash"));
    assert.throws(() => enforcePrimerEvidence({ plan, evidence: stripped }), /plan_hash/);
  });

  test("primer_order fails closed when release/landed timestamps are missing (barrier unprovable)", () => {
    const plan = makePlan();
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 10 }],
      reviewerReleases: [{ model: "model-a", requestPrefixFingerprint: fp, releasedAt: null }],
    });
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.check === "primer_order"));
    assert.throws(() => enforcePrimerEvidence({ plan, evidence: ev }), /primer_order/);
  });
});

describe("primer_order — deterministic, group-scoped binding (fan-in converge medium findings)", () => {
  test("an unkeyed release is NOT credited to a same-model keyed primer (fail-open closed)", () => {
    // A model with BOTH a keyed and an unkeyed primer group: partitionPrimerGroups
    // provably produces this. The unkeyed release here is released AFTER the
    // keyed group's earlier primer but BEFORE its own unkeyed primer — the exact
    // cross-credit that previously passed via first-match-by-model .find().
    const plan = buildReviewDispatchPlan({
      gate: "pre_approval_gate",
      headSha: "abcdef1234567890",
      sharedPrefixHash: fp,
      requestGroups: [
        { model: "model-a", requestPrefixFingerprint: fp, cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: "1h", angles: ["correctness"] },
        { model: "model-a", requestPrefixFingerprint: null, cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: "1h", angles: ["scope"] },
      ],
      capabilities: { harness: "claude" },
    });
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [
        { model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 1 },
        { model: "model-a", primerForm: PRIMER_FORM_DEDICATED, landedAt: 6 },
      ],
      reviewerReleases: [
        { model: "model-a", releasedAt: 4 }, // after keyed primer (1), before its own unkeyed primer (6)
      ],
    });
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, false, JSON.stringify(r.failures));
    assert.ok(r.failures.some((f) => f.check === "primer_order" && /releasedAt=4/.test(f.reason)));
    assert.throws(() => enforcePrimerEvidence({ plan, evidence: ev }), /primer_order/);
  });

  test("an unkeyed release with no unkeyed primer for its model fails closed on model_group", () => {
    // A model whose plan has ONLY a keyed group: nothing an unkeyed release may
    // bind to, so it must fail closed rather than be credited to the keyed primer.
    const plan = makePlan(); // single keyed group, model-a, fp
    const ev = buildPrimerEvidence({
      plan,
      primerRuns: [{ model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 1 }],
      reviewerReleases: [{ model: "model-a", releasedAt: 5 }],
    });
    const r = validatePrimerEvidence({ plan, evidence: ev });
    assert.equal(r.ok, false, JSON.stringify(r.failures));
    assert.ok(r.failures.some((f) => f.check === "model_group"));
    assert.throws(() => enforcePrimerEvidence({ plan, evidence: ev }), /model_group/);
  });

  test("primer_order is order-independent (no first-match-by-array-order defect)", () => {
    const plan = makePlan();
    const land = [5, 20];
    const release = { model: "model-a", requestPrefixFingerprint: fp, releasedAt: 10 }; // between the two primers
    const a = buildPrimerEvidence({
      plan,
      primerRuns: [
        { model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: land[0] },
        { model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_DEDICATED, landedAt: land[1] },
      ],
      reviewerReleases: [release],
    });
    const b = buildPrimerEvidence({
      plan,
      primerRuns: [
        { model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_DEDICATED, landedAt: land[1] },
        { model: "model-a", requestPrefixFingerprint: fp, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: land[0] },
      ],
      reviewerReleases: [release],
    });
    // The barrier must hold against the LAST-landed same-group primer (20), so a
    // release at t=10 fails identically regardless of run array order — the old
    // .find() first-match passed when landedAt:5 happened to come first.
    assert.equal(validatePrimerEvidence({ plan, evidence: a }).ok, false);
    assert.equal(validatePrimerEvidence({ plan, evidence: b }).ok, false);
    assert.equal(validatePrimerEvidence({ plan, evidence: a }).failures.some((f) => f.check === "primer_order"),
      validatePrimerEvidence({ plan, evidence: b }).failures.some((f) => f.check === "primer_order"));
  });
});
