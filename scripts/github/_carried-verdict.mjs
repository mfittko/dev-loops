/**
 * Carried gate verdicts across a base-only merge (issue 2752 slice 2, ADR 0156,
 * GATE-EXEC-BASE-MERGE-VERDICT-CARRY). A clean verdict marker at an earlier head
 * (the origin head) is presented as current-head only when re-classifying origin..head
 * yields `carry_verdict`. The carry is recomputed on every call from the posted marker and
 * git facts (a full-history checkout); no local state is read or trusted (ADR 0186).
 */
import { validateBaseMergeCarryEvidence } from "@dev-loops/core/loop/base-merge-verdict-carry";

import { computeBaseMergeCarry } from "./classify-base-merge-carry.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// The candidate shape under which carryGateMarker may carry (baseRef aside).
export function isCarryCandidate(marker, currentHeadSha) {
  const origin = marker?.headSha;
  return Boolean(marker?.visible) && marker.verdict === "clean" && marker.contractComplete === true
    && FULL_SHA_RE.test(origin ?? "") && FULL_SHA_RE.test(currentHeadSha ?? "") && origin !== currentHeadSha;
}

/**
 * @returns {Promise<object>} the marker, rewritten to the current head with `carriedFrom` when
 * the verdict carries, else the marker unchanged.
 */
export async function carryGateMarker(marker, { currentHeadSha, baseRef, repoRoot, runGit }) {
  const origin = marker?.headSha;
  if (!isCarryCandidate(marker, currentHeadSha) || !baseRef) return marker;
  const evidence = await computeBaseMergeCarry({ prevHead: origin, headSha: currentHeadSha, baseRef, repoRoot, ...(runGit ? { runGit } : {}) });
  const valid = evidence.decision === "carry_verdict"
    && validateBaseMergeCarryEvidence(evidence, { expectedSourceHead: origin, expectedNewHead: currentHeadSha }).ok;
  return valid ? { ...marker, headSha: currentHeadSha, carriedFrom: origin } : marker;
}
