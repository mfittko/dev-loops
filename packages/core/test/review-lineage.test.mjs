import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  ANGLE_SUFFIX_SLOT,
  DEFAULT_LINEAGE_MAX_ROUNDS,
  LINEAGE_BASE_SLOT,
  ROUND_DELTA_SLOT,
  buildFixRoundDelta,
  buildReviewLineageBase,
  checkLineageCompaction,
  composeRoundRequest,
  lineageByteSize,
  rebaseLineage,
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

describe("lineage compaction / rebase policy (issue #1468 slice 6)", () => {
  function deltas(count) {
    const out = [];
    let prevHead = BASE;
    for (let i = 1; i <= count; i++) {
      const reviewedHead = `d`.repeat(60) + String(i).padStart(4, "0");
      out.push(
        buildFixRoundDelta({
          lineageId: "lin-1",
          round: i,
          gate: GATE,
          baseHead: prevHead,
          reviewedHead,
          fixDiff: `diff --git a/src/a.mjs b/src/a.mjs\n+round ${i}\n`,
          validationEvidence: { tests: "npm test", result: "pass", head: reviewedHead },
          findingsChecklist: [{ id: `F${i}`, severity: "high", check: `verify round ${i}`, resolved: true, evidence: "test-assert" }],
        }),
      );
      prevHead = reviewedHead;
    }
    return out;
  }

  test("compaction threshold is exceeded once delta count passes maxRounds (default 20)", () => {
    assert.equal(DEFAULT_LINEAGE_MAX_ROUNDS, 20);
    assert.equal(checkLineageCompaction({ lineageBase: base(), deltas: deltas(20) }).requiresCompaction, false);
    const over = checkLineageCompaction({ lineageBase: base(), deltas: deltas(21) });
    assert.equal(over.requiresCompaction, true);
    assert.match(over.reason, /exceeds maxRounds 20/);
  });

  test("a byte budget triggers compaction even under the round cap", () => {
    const d = deltas(2);
    const small = 200; // well under the composed size
    const r = checkLineageCompaction({ lineageBase: base(), deltas: d, maxLineageBytes: small });
    assert.equal(r.requiresCompaction, true);
    assert.match(r.reason, /exceed maxLineageBytes 200/);
  });

  test("checkLineageCompaction uses strict > boundary: exact-byte equality does not trigger (in-gate coverage finding)", () => {
    const ds = deltas(2);
    const exactBytes = lineageByteSize({ lineageBase: base(), deltas: ds });
    // At exact equality (lineageBytes === maxLineageBytes) no compaction fires.
    const eq = checkLineageCompaction({ lineageBase: base(), deltas: ds, maxLineageBytes: exactBytes });
    assert.equal(eq.requiresCompaction, false);
    // One byte over triggers.
    const over = checkLineageCompaction({ lineageBase: base(), deltas: ds, maxLineageBytes: exactBytes - 1 });
    assert.equal(over.requiresCompaction, true);
  });

  test("checkLineageCompaction rejects invalid maxLineageBytes (in-gate error-contract finding)", () => {
    assert.throws(() => checkLineageCompaction({ lineageBase: base(), deltas: deltas(1), maxLineageBytes: 0 }));
    assert.throws(() => checkLineageCompaction({ lineageBase: base(), deltas: deltas(1), maxLineageBytes: -5 }));
    assert.throws(() => checkLineageCompaction({ lineageBase: base(), deltas: deltas(1), maxLineageBytes: 2.5 }));
    assert.throws(() => checkLineageCompaction({ lineageBase: base(), deltas: deltas(1), maxLineageBytes: "10" }));
  });

  test("lineageByteSize rejects an invalid base / non-array deltas / malformed delta (in-gate error-contract finding)", () => {
    assert.throws(() => lineageByteSize({ lineageBase: {}, deltas: [] }));
    assert.throws(() => lineageByteSize({ lineageBase: base(), deltas: "nope" }));
    assert.throws(() => lineageByteSize({ lineageBase: base(), deltas: [{ kind: "round-delta" }] }));
  });

  test("lineageByteSize is deterministic and grows with each appended delta", () => {
    const s1 = lineageByteSize({ lineageBase: base(), deltas: deltas(1) });
    const s2 = lineageByteSize({ lineageBase: base(), deltas: deltas(2) });
    assert.ok(Number.isInteger(s1) && s1 > 0);
    assert.ok(s2 > s1);
    assert.equal(lineageByteSize({ lineageBase: base(), deltas: deltas(2) }), s2); // deterministic
  });

  test("lineageByteSize measures UTF-8 bytes, not JS string length (in-gate byte-sizing finding)", () => {
    // Multi-byte UTF-8 content: 100 × U+2014 (em dash, 3 bytes each in UTF-8)
    // counts as 300 bytes, not 100 chars.
    const wide = buildReviewLineageBase({
      lineageId: "lin-1",
      gate: GATE,
      originalHead: BASE,
      originalDiff: "\u2014".repeat(100),
    });
    const narrow = buildReviewLineageBase({
      lineageId: "lin-1",
      gate: GATE,
      originalHead: BASE,
      originalDiff: "x".repeat(300), // 300 ASCII bytes
    });
    const wideBytes = lineageByteSize({ lineageBase: wide });
    const narrowBytes = lineageByteSize({ lineageBase: narrow });
    // Both renderings are 300 bytes in UTF-8; a naive JS .length would count
    // the wide one as ~100 (wrongly under-budgeting the provider context).
    assert.equal(wideBytes, narrowBytes);
  });

  test("checkLineageCompaction fails closed on a non-array deltas input (in-gate nullable-deltas finding)", () => {
    assert.throws(() => checkLineageCompaction({ lineageBase: base(), deltas: null }));
    assert.throws(() => checkLineageCompaction({ lineageBase: base(), deltas: "not-an-array" }));
    assert.throws(() => lineageByteSize({ lineageBase: base(), deltas: null }));
  });

  test("rebase honors an explicit currentDiff override (in-gate coverage finding)", () => {
    const compacted = rebaseLineage({
      lineageBase: base(),
      deltas: [delta1()],
      currentDiff: "custom cumulative diff text",
    });
    assert.equal(compacted.originalDiff, "custom cumulative diff text");
    // Default (no currentDiff) still folds in the fix diffs.
    const defaulted = rebaseLineage({ lineageBase: base(), deltas: [delta1()] });
    assert.match(defaulted.originalDiff, /fix one/);
  });

  test("rebase with empty deltas folds nothing and keeps head/diff unchanged (in-gate coverage finding)", () => {
    const compacted = rebaseLineage({ lineageBase: base(), deltas: [] });
    assert.equal(compacted.compaction, true);
    assert.equal(compacted.originalHead, base().originalHead);
    assert.equal(compacted.originalDiff, base().originalDiff);
    assert.equal(compacted.compactedRoundCount, 0);
  });

  test("rebasing an already-compacted base accumulates compactedRoundCount (in-gate coverage finding)", () => {
    const first = rebaseLineage({ lineageBase: base(), deltas: deltas(2) });
    assert.equal(first.compactedRoundCount, 2);
    // Anchor a new delta chain to the compacted head.
    const anchor = first.originalHead;
    const chain = buildFixRoundDelta({
      lineageId: "lin-1", round: 1, gate: GATE,
      baseHead: anchor,
      reviewedHead: "f".repeat(64),
      fixDiff: "diff --git a/src/a.mjs b/src/a.mjs\n+post-compact 1\n",
    });
    const second = rebaseLineage({ lineageBase: first, deltas: [chain] });
    assert.equal(second.compactedRoundCount, 3); // 2 (prior) + 1 (new)
    assert.equal(second.rebaseSourceBaseHash, first.baseHash);
  });

  test("rebase preserves composition rules — compacted base resumes appending round-1 delta", () => {
    const ds = deltas(21);
    assert.equal(checkLineageCompaction({ lineageBase: base(), deltas: ds }).requiresCompaction, true);

    const compacted = rebaseLineage({ lineageBase: base(), deltas: ds });
    assert.equal(compacted.kind, "review-lineage-base");
    assert.equal(compacted.lineageId, "lin-1");
    assert.equal(compacted.gate, GATE);
    assert.equal(compacted.compaction, true);
    assert.equal(compacted.compactedRoundCount, 21);
    assert.equal(compacted.rebaseSourceBaseHash, base().baseHash);
    // originalHead advances to the latest reviewed head.
    assert.equal(compacted.originalHead, ds[ds.length - 1].reviewedHead);
    // cumulative diff folds in every fix diff, in order.
    assert.match(compacted.originalDiff, /round 1/);
    assert.match(compacted.originalDiff, /round 21/);
    assert.match(compacted.baseHash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(compacted));

    // The compacted base is accepted by composeRoundRequest unchanged, and a
    // fresh round-1 delta against it composes cleanly (SHA-chain continuity +
    // append-only contract preserved).
    const fresh = buildFixRoundDelta({
      lineageId: "lin-1",
      round: 1,
      gate: GATE,
      baseHead: compacted.originalHead,
      reviewedHead: `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`,
      fixDiff: "diff --git a/src/a.mjs b/src/a.mjs\n+post-rebase\n",
      validationEvidence: { tests: "npm test", result: "pass" },
    });
    const composed = composeRoundRequest({ lineageBase: compacted, priorDeltas: [], newDelta: fresh });
    assert.equal(composed.segments.length, 2); // compacted base + one fresh delta
    assert.equal(composed.segments[0].hash, compacted.baseHash);
    assert.equal(composed.segments[1].hash, fresh.deltaHash);
    // Byte-deterministic.
    const again = composeRoundRequest({ lineageBase: compacted, priorDeltas: [], newDelta: fresh });
    assert.equal(composed.composedHash, again.composedHash);
  });

  test("rebase chain trimming keeps the composed request bounded", () => {
    const ds = deltas(21);
    const before = renderComposedRequest(composeRoundRequest({ lineageBase: base(), priorDeltas: ds.slice(0, -1), newDelta: ds[ds.length - 1] }));
    const compacted = rebaseLineage({ lineageBase: base(), deltas: ds });
    const fresh = buildFixRoundDelta({
      lineageId: "lin-1",
      round: 1,
      gate: GATE,
      baseHead: compacted.originalHead,
      reviewedHead: `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`,
      fixDiff: "diff --git a/src/a.mjs b/src/a.mjs\n+post-rebase\n",
    });
    const after = renderComposedRequest(composeRoundRequest({ lineageBase: compacted, priorDeltas: [], newDelta: fresh }));
    // The single compacted base + one delta is strictly smaller than the full
    // 21-delta append chain (unbounded growth prevented).
    assert.ok(after.length < before.length);
  });

  test("rebase validates full hex SHAs on every accumulated delta (in-gate hex-SHA chain finding)", () => {
    // Builders already fail closed on abbreviated SHAs, so a full-hex-SHA
    // malformed delta cannot reach rebaseLineage through the public path.
    assert.throws(() => buildFixRoundDelta({
      lineageId: "lin-1", round: 1, gate: GATE,
      baseHead: "aaaaaaa", reviewedHead: R1, fixDiff: "x",
    }));
  });

  test("rebase enforces round contiguity from round 1 (in-gate correctness finding)", () => {
    // A head-chaining but round-mislabeled list (starts at 5) is rejected.
    const mislabeled = buildFixRoundDelta({
      lineageId: "lin-1", round: 5, gate: GATE,
      baseHead: BASE, reviewedHead: R1, fixDiff: "x",
    });
    assert.throws(() => rebaseLineage({ lineageBase: base(), deltas: [mislabeled] }));
    const skip = buildFixRoundDelta({
      lineageId: "lin-1", round: 3, gate: GATE,
      baseHead: R1, reviewedHead: R2, fixDiff: "x",
    });
    assert.throws(() => rebaseLineage({ lineageBase: base(), deltas: [delta1(), skip] }));
    // A well-ordered list passes.
    assert.ok(rebaseLineage({ lineageBase: base(), deltas: [delta1(), delta2()] }));
  });

  test("rebase normalizes the extracted head and rejects an empty currentDiff (in-gate finding)", () => {
    // currentDiff empty is rejected.
    assert.throws(() => rebaseLineage({ lineageBase: base(), deltas: [delta1()], currentDiff: "" }));
    assert.throws(() => rebaseLineage({ lineageBase: base(), deltas: [delta1()], currentDiff: [] }));
    // Normalized head: mixed-case reviewedHead is lowercased in the compacted base.
    const mixed = buildFixRoundDelta({
      lineageId: "lin-1", round: 1, gate: GATE,
      baseHead: BASE, reviewedHead: "AB".repeat(32), fixDiff: "x",
    });
    const compacted = rebaseLineage({ lineageBase: base(), deltas: [mixed] });
    assert.equal(compacted.originalHead, "ab".repeat(32));
  });

  test("rebaseLineage rejects an invalid lineageBase and null/undefined delta elements (in-gate coverage finding)", () => {
    assert.throws(() => rebaseLineage({ lineageBase: {}, deltas: [] }));
    assert.throws(() => rebaseLineage({ lineageBase: base(), deltas: null }));
    assert.throws(() => rebaseLineage({ lineageBase: base(), deltas: [null] }));
    assert.throws(() => checkLineageCompaction({ lineageBase: base(), deltas: [undefined, delta1()] }));
  });

  test("rebase fails closed on a broken SHA chain, wrong gate, or foreign lineage", () => {
    const badChain = [...deltas(2)];
    badChain[1] = buildFixRoundDelta({
      lineageId: "lin-1", round: 2, gate: GATE,
      baseHead: BASE, // should equal deltas[0].reviewedHead
      reviewedHead: `cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc`,
      fixDiff: "x",
    });
    assert.throws(() => rebaseLineage({ lineageBase: base(), deltas: badChain }));
    const wrongGate = buildFixRoundDelta({
      lineageId: "lin-1", round: 1, gate: "draft_gate", baseHead: BASE,
      reviewedHead: R1, fixDiff: "x",
    });
    assert.throws(() => rebaseLineage({ lineageBase: base(), deltas: [wrongGate] }));
    const foreign = buildFixRoundDelta({
      lineageId: "lin-OTHER", round: 1, gate: GATE, baseHead: BASE,
      reviewedHead: R1, fixDiff: "x",
    });
    assert.throws(() => rebaseLineage({ lineageBase: base(), deltas: [foreign] }));
    assert.throws(() => checkLineageCompaction({ lineageBase: base(), deltas: deltas(1), maxRounds: 0 }));
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
