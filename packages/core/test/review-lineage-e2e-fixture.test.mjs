import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";

import {
  buildReviewDispatchPlan,
  CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
  PRIMER_FORM_LEAD_REVIEWER,
} from "../src/loop/review-dispatch-plan.mjs";
import {
  buildPrimerEvidence,
  validatePrimerEvidence,
} from "../src/loop/primer-evidence.mjs";
import {
  consolidateFanin,
  planFanoutBatches,
} from "../src/loop/gate-fanin.mjs";
import {
  buildFixRoundDelta,
  buildReviewLineageBase,
  checkLineageCompaction,
  composeRoundRequest,
  rebaseLineage,
} from "../src/loop/review-lineage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "lineage-e2e", "pipeline.json"), "utf8"),
);

/**
 * End-to-end lineage fixture (issue #1468 slice 6): drives the real cache-aware
 * review pipeline across two rounds and closes with a compaction, in the order
 * the #1478 AC demands:
 *
 *   context build -> request plan -> primer -> fan-out -> fan-in -> lineage delta
 *
 * Every step uses its production module — no inline re-implementations.
 */
describe("review-lineage e2e fixture (2 rounds + compaction)", () => {
  test("round 1: build plan -> prime -> fan-out/fan-in (findings) -> delta -> compose", () => {
    const round1 = FIXTURE.rounds[0];
    const lineageBase = buildReviewLineageBase({
      lineageId: "fixture-1",
      gate: FIXTURE.gate,
      originalHead: FIXTURE.baseHead,
      originalDiff: FIXTURE.originalDiff,
      stableContracts: "review agent instructions v1",
    });

    // 1. Request plan (context build -> request plan).
    const plan = buildReviewDispatchPlan({
      gate: FIXTURE.gate,
      headSha: round1.head,
      sharedPrefixHash: FIXTURE.sharedPrefixHash,
      requestGroups: [
        {
          model: FIXTURE.model,
          requestPrefixFingerprint: FIXTURE.requestPrefixFingerprint,
          cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
          ttlIntent: "1h",
          angles: FIXTURE.angles,
        },
      ],
      capabilities: { harness: "claude" },
    });
    assert.match(plan.planHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(plan.requestGroups[0].angles.length, 2);

    // 2. Primer (lead reviewer primes the group; ordering evidence validated).
    const evidence = buildPrimerEvidence({
      plan,
      primerRuns: [
        {
          model: FIXTURE.model,
          requestPrefixFingerprint: FIXTURE.requestPrefixFingerprint,
          primerForm: PRIMER_FORM_LEAD_REVIEWER,
          landedAt: 10,
        },
      ],
      reviewerReleases: [
        { model: FIXTURE.model, requestPrefixFingerprint: FIXTURE.requestPrefixFingerprint, releasedAt: 11 },
      ],
    });
    const validation = validatePrimerEvidence({ plan, evidence });
    assert.equal(validation.ok, true, JSON.stringify(validation.failures));

    // 3. Fan-out schedule (fan-out).
    const { batches } = planFanoutBatches(FIXTURE.angles, 4);
    assert.equal(batches.length, 1);

    // 4. Fan-in (round 1 has a high-severity finding -> findings_present).
    const fanin = consolidateFanin({ angleResults: round1.angleResults, blockCleanOnFindingSeverities: ["high"] });
    assert.equal(fanin.verdict, "findings_present");
    assert.equal(fanin.counts.blocking, 1);

    // 5. Lineage delta + compose round-1 request.
    const delta1 = buildFixRoundDelta({
      lineageId: "fixture-1",
      round: 1,
      gate: FIXTURE.gate,
      baseHead: lineageBase.originalHead,
      reviewedHead: round1.head,
      fixDiff: round1.fixDiff,
      validationEvidence: round1.validation,
      findingsChecklist: round1.checklist,
    });
    const composed1 = composeRoundRequest({ lineageBase, priorDeltas: [], newDelta: delta1 });
    assert.equal(composed1.segments.length, 2); // base + delta1
    assert.equal(composed1.segments[0].hash, lineageBase.baseHash);
    assert.equal(composed1.segments[1].hash, delta1.deltaHash);
  });

  test("round 2: append-only delta over a clean fan-in, then compaction", () => {
    const round1 = FIXTURE.rounds[0];
    const round2 = FIXTURE.rounds[1];
    const lineageBase = buildReviewLineageBase({
      lineageId: "fixture-1",
      gate: FIXTURE.gate,
      originalHead: FIXTURE.baseHead,
      originalDiff: FIXTURE.originalDiff,
      stableContracts: "review agent instructions v1",
    });

    const plan2 = buildReviewDispatchPlan({
      gate: FIXTURE.gate,
      headSha: round2.head,
      sharedPrefixHash: FIXTURE.sharedPrefixHash,
      requestGroups: [
        {
          model: FIXTURE.model,
          requestPrefixFingerprint: FIXTURE.requestPrefixFingerprint,
          cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
          ttlIntent: "1h",
          angles: FIXTURE.angles,
        },
      ],
      capabilities: { harness: "claude" },
    });
    const evidence2 = buildPrimerEvidence({
      plan: plan2,
      primerRuns: [
        { model: FIXTURE.model, requestPrefixFingerprint: FIXTURE.requestPrefixFingerprint, primerForm: PRIMER_FORM_LEAD_REVIEWER, landedAt: 20 },
      ],
      reviewerReleases: [
        { model: FIXTURE.model, requestPrefixFingerprint: FIXTURE.requestPrefixFingerprint, releasedAt: 21 },
      ],
    });
    assert.equal(validatePrimerEvidence({ plan: plan2, evidence: evidence2 }).ok, true);

    // Round 2 is clean (fan-in clean).
    const fanin2 = consolidateFanin({ angleResults: round2.angleResults, blockCleanOnFindingSeverities: ["high"] });
    assert.equal(fanin2.verdict, "clean");

    // Round 1 delta + round 2 delta compose append-only.
    const delta1 = buildFixRoundDelta({
      lineageId: "fixture-1", round: 1, gate: FIXTURE.gate,
      baseHead: lineageBase.originalHead, reviewedHead: round1.head, fixDiff: round1.fixDiff,
      validationEvidence: round1.validation, findingsChecklist: round1.checklist,
    });
    const delta2 = buildFixRoundDelta({
      lineageId: "fixture-1", round: 2, gate: FIXTURE.gate,
      baseHead: round1.head, reviewedHead: round2.head, fixDiff: round2.fixDiff,
      validationEvidence: round2.validation, findingsChecklist: round2.checklist,
    });
    const round2Composed = composeRoundRequest({ lineageBase, priorDeltas: [delta1], newDelta: delta2 });
    assert.equal(round2Composed.segments.length, 3); // base + delta1 + delta2

    // Small lineage: no compaction needed yet, but the path closes cleanly.
    const comp = checkLineageCompaction({ lineageBase, deltas: [delta1, delta2], maxRounds: 20 });
    assert.equal(comp.requiresCompaction, false);

    // Drive a forced rebase to prove the compacted lineage still satisfies the
    // composition rules (append-only, byte-deterministic, SHA-chain continuity).
    const compacted = rebaseLineage({ lineageBase, deltas: [delta1, delta2] });
    assert.equal(compacted.originalHead, round2.head);
    assert.match(compacted.originalDiff, /fix one/);
    assert.match(compacted.originalDiff, /fix two/);
    const fresh = buildFixRoundDelta({
      lineageId: "fixture-1", round: 1, gate: FIXTURE.gate,
      baseHead: compacted.originalHead, reviewedHead: "3".repeat(64), fixDiff: "diff --git a/src/pipeline.mjs b/src/pipeline.mjs\n+round 3\n",
    });
    const recomposed = composeRoundRequest({ lineageBase: compacted, priorDeltas: [], newDelta: fresh });
    assert.equal(recomposed.segments[0].hash, compacted.baseHash);
    assert.equal(recomposed.segments[1].hash, fresh.deltaHash);
    assert.equal(
      recomposed.composedHash,
      composeRoundRequest({ lineageBase: compacted, priorDeltas: [], newDelta: fresh }).composedHash,
    );
  });
});
