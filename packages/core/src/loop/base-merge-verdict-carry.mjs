/**
 * base-merge-verdict-carry — pure, fail-closed classifier for a head advance
 * that only merged the base branch (issue 2752, ADR 0156).
 *
 * Decision values:
 * - carry_verdict: patch id identical, no path overlap with the base delta, and the
 *   base delta touches no gate tooling or config.
 * - partial_carry: patch id identical, overlap non-empty; defer to the angle
 *   carry-forward (GATE-EXEC-ANGLE-CARRY-FORWARD).
 * - full_regate: gate tooling in the base delta, conflict-resolution hunks, or a
 *   changed patch.
 * - fallback_full: any detection failure or malformed input.
 */
import { isDevLoopConfigSourcePath } from "../analysis/diff-analyzer.mjs";

export const BASE_MERGE_CARRY_DECISIONS = Object.freeze(["carry_verdict", "partial_carry", "full_regate", "fallback_full"]);

// Paths whose change alters how a gate runs: gate contracts, gate scripts and
// core loop code, the installed dev-loops version (manifests and lockfiles), CI.
const GATE_TOOLING_RE = /^(skills\/|scripts\/|packages\/core\/src\/(loop|config)\/|\.github\/|package\.json$|bun\.lockb?$|packages\/[^/]+\/package\.json$)/;

export function isGateToolingPath(filePath) {
  if (typeof filePath !== "string") return false;
  const p = filePath.trim().replace(/\\/g, "/");
  return isDevLoopConfigSourcePath(p) || GATE_TOOLING_RE.test(p);
}

const FULL_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const isPathList = (v) => Array.isArray(v) && v.every((p) => typeof p === "string" && p.length > 0);

/**
 * @param {object} input
 * @param {string} input.sourceHead  previous head A
 * @param {string} input.newHead     new head B
 * @param {string} input.patchIdBefore  stable patch id of the PR diff at A
 * @param {string} input.patchIdAfter   stable patch id of the PR diff at B
 * @param {string[]} input.prDiffPaths  paths in the PR's own diff (at B)
 * @param {string[]} input.baseDeltaPaths paths the base delta (merge-base A..B) touched
 * @param {boolean} [input.conflictResolutionHunks] true when the merge resolved conflicts
 * @param {string} [input.detectionError] set when computing any input failed
 */
export function classifyBaseMergeCarry(input = {}) {
  const { sourceHead, newHead, patchIdBefore, patchIdAfter, prDiffPaths, baseDeltaPaths, conflictResolutionHunks = false, detectionError } = input;
  const evidence = {
    sourceHead: sourceHead ?? null,
    newHead: newHead ?? null,
    patchIdBefore: patchIdBefore ?? null,
    patchIdAfter: patchIdAfter ?? null,
    pathIntersection: [],
    gateToolingPaths: [],
    decision: "fallback_full",
    reason: "",
  };
  const done = (decision, reason) => ({ ...evidence, decision, reason });

  if (detectionError) return done("fallback_full", `detection failed: ${detectionError}`);
  if (!FULL_SHA_RE.test(sourceHead ?? "") || !FULL_SHA_RE.test(newHead ?? "") || sourceHead === newHead) {
    return done("fallback_full", "sourceHead/newHead must be distinct full SHAs");
  }
  if (!patchIdBefore || !patchIdAfter) return done("fallback_full", "patch id missing");
  if (!isPathList(prDiffPaths) || !isPathList(baseDeltaPaths) || typeof conflictResolutionHunks !== "boolean") {
    return done("fallback_full", "malformed path lists");
  }
  const prPaths = new Set(prDiffPaths);
  evidence.pathIntersection = [...new Set(baseDeltaPaths.filter((p) => prPaths.has(p)))].sort();
  evidence.gateToolingPaths = [...new Set(baseDeltaPaths.filter(isGateToolingPath))].sort();

  if (patchIdBefore !== patchIdAfter) return done("full_regate", "PR patch changed");
  if (conflictResolutionHunks) return done("full_regate", "merge carries conflict-resolution hunks");
  if (evidence.gateToolingPaths.length > 0) return done("full_regate", "base delta touches gate tooling or config");
  if (evidence.pathIntersection.length > 0) return done("partial_carry", "base delta overlaps PR paths; use angle carry-forward");
  return done("carry_verdict", "patch identical, no overlap, no gate tooling in base delta");
}

/**
 * Tamper-evidence check for merge-pr: shape plus decision recomputed from the
 * recorded facts. Returns { ok, reason }.
 */
export function validateBaseMergeCarryEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return { ok: false, reason: "evidence missing" };
  const keys = ["sourceHead", "newHead", "patchIdBefore", "patchIdAfter", "pathIntersection", "gateToolingPaths", "decision", "reason"];
  for (const k of keys) if (!(k in evidence)) return { ok: false, reason: `missing field ${k}` };
  if (!BASE_MERGE_CARRY_DECISIONS.includes(evidence.decision)) return { ok: false, reason: "unknown decision" };
  if (!isPathList(evidence.pathIntersection) || !isPathList(evidence.gateToolingPaths)) return { ok: false, reason: "malformed path lists" };
  if (evidence.decision === "carry_verdict") {
    if (!FULL_SHA_RE.test(evidence.sourceHead) || !FULL_SHA_RE.test(evidence.newHead) || evidence.sourceHead === evidence.newHead) return { ok: false, reason: "invalid heads" };
    if (!evidence.patchIdBefore || evidence.patchIdBefore !== evidence.patchIdAfter) return { ok: false, reason: "carry_verdict with differing patch ids" };
    if (evidence.pathIntersection.length > 0 || evidence.gateToolingPaths.length > 0) return { ok: false, reason: "carry_verdict with overlap or gate tooling" };
  }
  return { ok: true, reason: "" };
}
