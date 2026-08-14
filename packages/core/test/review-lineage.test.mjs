import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  ANGLE_SUFFIX_SLOT,
  LINEAGE_BASE_SLOT,
  ROUND_DELTA_SLOT,
  buildFixRoundDelta,
  buildReviewLineageBase,
  composeRoundRequest,
  renderComposedRequest,
} from "../src/loop/review-lineage.mjs";

const GATE = "pre_approval_gate";
const BASE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const R1 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const R2 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const FIX1 = "diff --git a/src/a.mjs b/src/a.mjs\n+fix one\n";
const FIX2 = "diff --git a/src/a.mjs b/src/a.mjs\n+fix two\n";
const VALIDATION1 = { tests: "npm test", result: "pass" };
const CHECKLIST1 = [
  { id: "F1", severity: "high", check: "verify fix one resolves F1", resolved: true, evidence: "test-assert" },
];

function base() {
  return buildReviewLineageBase({
    lineageId: "lin-1",
    gate: GATE,
    originalHead: BASE,
    originalDiff: "diff --git a/src/a.mjs b/src/a.mjs\n-original\n+intro\n",
    stableContracts: "review agent instructions v1",
  });
}

function delta1() {
  return buildFixRoundDelta({
    lineageId: "lin-1",
    round: 1,
    gate: GATE,
    baseHead: BASE,
    reviewedHead: R1,
    fixDiff: FIX1,
    validationEvidence: VALIDATION1,
    findingsChecklist: CHECKLIST1,
  });
}

function delta2() {
  return buildFixRoundDelta({
    lineageId: "lin-1",
    round: 2,
    gate: GATE,
    baseHead: R1,
    reviewedHead: R2,
    fixDiff: FIX2,
    validationEvidence: { tests: "npm test", result: "pass", head: R2 },
    findingsChecklist: [
      { id: "F1", severity: "high", check: "verify fix one resolves F1", resolved: true, evidence: "test-assert" },
      { id: "F2", severity: "med", check: "verify fix two resolves F2", resolved: true, evidence: "reviewed-diff" },
    ],
  });
}

describe("review-lineage base — Section E", () => {
  test("base artifact records lineage identity, gate, original head and original full diff", () => {
    const b = base();
    assert.equal(b.kind, "review-lineage-base");
    assert.equal(b.lineageId, "lin-1");
    assert.equal(b.gate, GATE);
    assert.equal(b.originalHead, BASE);
    assert.match(b.originalDiff, /-original/);
    assert.match(b.originalDiff, /\+intro/);
    assert.match(b.baseHash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(b));
  });

  test("base is byte-deterministic: identical inputs produce identical baseHash", () => {
    assert.equal(base().baseHash, base().baseHash);
    // Same content, different object shape/ordering -> same hash.
    const b2 = buildReviewLineageBase({
      stableContracts: "review agent instructions v1",
      originalDiff: "diff --git a/src/a.mjs b/src/a.mjs\n-original\n+intro\n",
      lineageId: "lin-1",
      gate: GATE,
      originalHead: BASE,
    });
    assert.equal(b2.baseHash, base().baseHash);
  });

  test("base differs when the original diff or head changes", () => {
    const changed = buildReviewLineageBase({
      lineageId: "lin-1",
      gate: GATE,
      originalHead: BASE,
      originalDiff: "different diff",
    });
    assert.notEqual(changed.baseHash, base().baseHash);
  });

  test("invalid base input fails closed", () => {
    assert.throws(() =>
      buildReviewLineageBase({ lineageId: "", gate: GATE, originalHead: BASE, originalDiff: "d" }),
    );
    assert.throws(() =>
      buildReviewLineageBase({ lineageId: "l", gate: GATE, originalHead: "not-a-sha", originalDiff: "d" }),
    );
    assert.throws(() =>
      buildReviewLineageBase({ lineageId: "l", gate: GATE, originalHead: BASE, originalDiff: "" }),
    );
  });
});

describe("per-fix-round delta — Section E", () => {
  test("delta records exact SHAs, fix diff, validation evidence and independent checklist", () => {
    const d = delta1();
    assert.equal(d.kind, "round-delta");
    assert.equal(d.round, 1);
    assert.equal(d.baseHead, BASE);
    assert.equal(d.reviewedHead, R1);
    assert.match(d.fixDiff, /fix one/);
    assert.deepEqual(d.validationEvidence, VALIDATION1);
    assert.deepEqual(d.findingsChecklist, CHECKLIST1);
    assert.match(d.deltaHash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(d));
  });

  test("delta is deterministic and distinguishes rounds", () => {
    assert.equal(delta1().deltaHash, delta1().deltaHash);
    assert.notEqual(delta1().deltaHash, delta2().deltaHash);
  });

  test("findings checklist is an independent checklist, not verdict prose", () => {
    const d = delta1();
    assert.ok(Array.isArray(d.findingsChecklist));
    for (const f of d.findingsChecklist) {
      assert.ok(typeof f.check === "string");
    }
  });

  test("invalid delta input fails closed", () => {
    assert.throws(() => buildFixRoundDelta({ lineageId: "l", round: 0, gate: GATE, baseHead: BASE, reviewedHead: R1, fixDiff: "d" }));
    assert.throws(() => buildFixRoundDelta({ lineageId: "l", round: 1, gate: GATE, baseHead: "x", reviewedHead: R1, fixDiff: "d" }));
    assert.throws(() => buildFixRoundDelta({ lineageId: "l", round: 1, gate: GATE, baseHead: BASE, reviewedHead: R1, fixDiff: "" }));
    assert.throws(() => buildFixRoundDelta({ lineageId: "l", round: 1, gate: GATE, baseHead: BASE, reviewedHead: R1, fixDiff: "d", findingsChecklist: [{ id: "F", check: "c", resolved: true, evidence: "x" }, 42] }));
  });
});

describe("append-only round request composition — Section E (AC-2)", () => {
  test("round 2 reuses the lineage base + prior delta and appends only the new delta", () => {
    const b = base();
    const d1 = delta1();
    const d2 = delta2();

    const round1 = composeRoundRequest({ lineageBase: b, priorDeltas: [], newDelta: d1 });
    const round2 = composeRoundRequest({ lineageBase: b, priorDeltas: [d1], newDelta: d2 });

    // Round 2 has exactly ONE more segment than round 1: the new delta.
    assert.equal(round2.segments.length, round1.segments.length + 1);

    // Every prior segment (base + delta 1) is byte-identical (same ref + hash).
    const priorKeys = round1.segments.map((s) => `${s.slot}:${s.ref}:${s.hash}`);
    const round2Prior = round2.segments.slice(0, round1.segments.length);
    assert.deepEqual(round2Prior.map((s) => `${s.slot}:${s.ref}:${s.hash}`), priorKeys);
    assert.deepEqual(round2Prior.map((s) => s.bytes), round1.segments.map((s) => s.bytes));

    // The lineage base appears exactly once, byte-identical across rounds.
    const baseSegs = round2.segments.filter((s) => s.slot === LINEAGE_BASE_SLOT);
    assert.equal(baseSegs.length, 1);
    assert.equal(baseSegs[0].hash, b.baseHash);
    assert.deepEqual(JSON.parse(baseSegs[0].bytes), JSON.parse(JSON.stringify(b)));

    // The appended delta is exactly delta 2 (canonical bytes).
    const appended = round2.segments[round2.segments.length - (round2.segments.find((s) => s.slot === ANGLE_SUFFIX_SLOT) ? 2 : 1)];
    assert.equal(appended.slot, ROUND_DELTA_SLOT);
    assert.equal(appended.round, 2);
    assert.equal(appended.hash, d2.deltaHash);
    assert.deepEqual(JSON.parse(appended.bytes), JSON.parse(JSON.stringify(d2)));

    // Append-only: round2 rendered bytes = round1 rendered bytes + the new
    // delta's canonical bytes (byte-identical reuse of every prior segment).
    assert.equal(
      renderComposedRequest(round2),
      renderComposedRequest(round1) + JSON.stringify({ ...JSON.parse(appended.bytes) }),
    );
  });

  test("angle suffix segment is appended last ([lineage base][deltas][angle suffix] contract)", () => {
    const b = base();
    const d1 = delta1();
    const d2 = delta2();
    const suffix = "review the diff against the acceptance criteria only";

    // Round 1 with a suffix: the suffix is the trailing segment.
    const round1 = composeRoundRequest({ lineageBase: b, priorDeltas: [], newDelta: d1, angleSuffix: suffix });
    const tail1 = round1.segments[round1.segments.length - 1];
    assert.equal(tail1.slot, ANGLE_SUFFIX_SLOT);
    assert.equal(tail1.ref, "angle-suffix");
    assert.equal(tail1.bytes, suffix);

    // Round 2 with the same suffix appends exactly one new delta before the suffix.
    const round2 = composeRoundRequest({ lineageBase: b, priorDeltas: [d1], newDelta: d2, angleSuffix: suffix });
    assert.equal(round2.segments.length, round1.segments.length + 1);
    const tail2 = round2.segments[round2.segments.length - 1];
    assert.equal(tail2.slot, ANGLE_SUFFIX_SLOT);
    // Suffix is byte-identical across rounds (append-only, prior segments reused).
    assert.equal(tail2.bytes, tail1.bytes);
    // The appended delta sits directly before the suffix.
    assert.equal(round2.segments[round2.segments.length - 2].slot, ROUND_DELTA_SLOT);
    assert.equal(round2.segments[round2.segments.length - 2].round, 2);

    // A Buffer suffix is normalized to a utf8 string.
    const roundBuf = composeRoundRequest({ lineageBase: b, priorDeltas: [], newDelta: d1, angleSuffix: Buffer.from("suffix-bytes") });
    assert.equal(roundBuf.segments[roundBuf.segments.length - 1].bytes, "suffix-bytes");
  });

  test("segment bytes are key-order-canonical (byte-deterministic for nested objects)", () => {
    const dA = buildFixRoundDelta({
      lineageId: "lin-1", round: 1, gate: GATE, baseHead: BASE, reviewedHead: R1, fixDiff: FIX1,
      validationEvidence: { tests: "npm test", result: "pass" },
      findingsChecklist: [{ severity: "high", check: "c", resolved: true, evidence: "e" }],
    });
    const dB = buildFixRoundDelta({
      lineageId: "lin-1", round: 1, gate: GATE, baseHead: BASE, reviewedHead: R1, fixDiff: FIX1,
      validationEvidence: { result: "pass", tests: "npm test" }, // different key order
      findingsChecklist: [{ resolved: true, severity: "high", evidence: "e", check: "c" }], // different order
    });
    const rA = composeRoundRequest({ lineageBase: base(), priorDeltas: [], newDelta: dA });
    const rB = composeRoundRequest({ lineageBase: base(), priorDeltas: [], newDelta: dB });
    assert.equal(dA.deltaHash, dB.deltaHash);
    assert.equal(rA.composedHash, rB.composedHash);
    assert.equal(renderComposedRequest(rA), renderComposedRequest(rB));
  });

  test("does NOT rebuild the full PR context as a replacement block", () => {
    const b = base();
    const d1 = delta1();
    const d2 = delta2();
    const round2 = composeRoundRequest({ lineageBase: b, priorDeltas: [d1], newDelta: d2 });

    // A full-PR-context replacement block would re-emit the entire original
    // diff / context in every round. Here the base original diff appears once
    // (inside the base segment only) and the fix diffs appear once each inside
    // their own delta segments — no re-serialized aggregate.
    const bytes = renderComposedRequest(round2);
    assert.equal(countOccurrences(bytes, "diff --git a/src/a.mjs"), 3); // original intro + fix1 + fix2
    // The base artifact's stable fingerprint appears exactly once -> base is not
    // duplicated/rebuild as a replacement block.
    assert.equal(countOccurrences(bytes, b.baseHash), 1);
    // Round-2 delta bytes do not re-embed the original full diff.
    assert.equal(JSON.stringify(d2).includes("original"), false);
  });

  test("composition is deterministic and byte-identical", () => {
    const roundA = composeRoundRequest({ lineageBase: base(), priorDeltas: [delta1()], newDelta: delta2() });
    const roundB = composeRoundRequest({ lineageBase: base(), priorDeltas: [delta1()], newDelta: delta2() });
    assert.equal(roundA.composedHash, roundB.composedHash);
    assert.equal(renderComposedRequest(roundA), renderComposedRequest(roundB));
  });

  test("carried clean angle records its original reviewer and prior head (carry-forward unchanged)", () => {
    const round = composeRoundRequest({
      lineageBase: base(),
      priorDeltas: [delta1()],
      newDelta: delta2(),
      carriedAngles: [{ angle: "security", originalReviewer: "rev-security-1", priorHead: R1 }],
    });
    const carried = round.carriedAngles.find((c) => c.angle === "security");
    assert.equal(carried.originalReviewer, "rev-security-1");
    assert.equal(carried.priorHead, R1);
    assert.ok(Object.isFrozen(round));
  });

  test("contiguity + cross-lineage mismatches fail closed", () => {
    const b = base();
    const d1 = delta1();
    const d2 = delta2();
    // Non-contiguous (skip round 1): newDelta.round must follow priorDeltas.
    assert.throws(() => composeRoundRequest({ lineageBase: b, priorDeltas: [], newDelta: d2 }));
    assert.throws(() => composeRoundRequest({ lineageBase: b, priorDeltas: [d2], newDelta: d1 }));
    // Cross-lineage.
    const otherDelta = buildFixRoundDelta({ lineageId: "lin-OTHER", round: 1, gate: GATE, baseHead: BASE, reviewedHead: R1, fixDiff: FIX1 });
    assert.throws(() => composeRoundRequest({ lineageBase: b, priorDeltas: [], newDelta: otherDelta }));
    // Invalid base / delta.
    assert.throws(() => composeRoundRequest({ lineageBase: {}, newDelta: d1 }));
    assert.throws(() => composeRoundRequest({ lineageBase: b, newDelta: {} }));
  });

  test("SHA-chain continuity is enforced (in-gate correctness finding)", () => {
    const b = base();
    const d1 = delta1(); // baseHead=BASE(reviewed r1).
    // Round 1 whose baseHead != base.originalHead fails.
    const badR1 = buildFixRoundDelta({ lineageId: "lin-1", round: 1, gate: GATE, baseHead: R2, reviewedHead: R1, fixDiff: FIX1 });
    assert.throws(() => composeRoundRequest({ lineageBase: b, priorDeltas: [], newDelta: badR1 }));
    // Round 2 whose baseHead != prior delta's reviewedHead fails.
    const badR2 = buildFixRoundDelta({ lineageId: "lin-1", round: 2, gate: GATE, baseHead: BASE, reviewedHead: R2, fixDiff: FIX2 });
    assert.throws(() => composeRoundRequest({ lineageBase: b, priorDeltas: [d1], newDelta: badR2 }));
    // A well-linked chain passes.
    assert.ok(composeRoundRequest({ lineageBase: b, priorDeltas: [d1], newDelta: delta2() }));
  });

  test("gate consistency is enforced across base and deltas (in-gate scope finding)", () => {
    const b = base();
    const wrongGate = buildFixRoundDelta({ lineageId: "lin-1", round: 1, gate: "draft_gate", baseHead: BASE, reviewedHead: R1, fixDiff: FIX1 });
    assert.throws(() => composeRoundRequest({ lineageBase: b, priorDeltas: [], newDelta: wrongGate }));
  });

  test("abbreviated SHA prefixes are rejected (in-gate input-validation finding)", () => {
    // Original head may not be an abbreviated 7-hex prefix.
    assert.throws(() => buildReviewLineageBase({ lineageId: "l", gate: GATE, originalHead: "aaaaaaa", originalDiff: "d" }));
    // All SHAs must be full-length.
    assert.throws(() => buildFixRoundDelta({ lineageId: "l", round: 1, gate: GATE, baseHead: "bbbbbbbb", reviewedHead: R1, fixDiff: "d" }));
  });
});

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}
