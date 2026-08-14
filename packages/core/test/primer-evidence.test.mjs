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
