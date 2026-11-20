/**
 * base-merge-verdict-carry — pure, fail-closed classifier for a head advance
 * that only merged the base branch (issue 2752, ADR 0156).
 *
 * The facts are raw tree-entry blob facts (`path<TAB>mode<TAB>oid` lists from
 * `git diff-tree --raw`), never rendered diffs.
 *
 * Decision values:
 * - carry_verdict: every PR path has the same mode and blob oid at both heads, the base
 *   delta does not intersect the PR paths, and it touches no gate tooling or config.
 * - full_regate: a PR blob changed, the base delta overlaps the PR paths, gate tooling
 *   in the base delta, or conflict-resolution hunks.
 * - fallback_full: any detection failure or malformed input.
 */
import { isDevLoopConfigSourcePath } from "../analysis/diff-analyzer.mjs";

export const BASE_MERGE_CARRY_DECISIONS = Object.freeze(["carry_verdict", "full_regate", "fallback_full"]);

// Paths that can change a gate outcome (ADR 0296, amends ADR 0096 and ADR 0156): .devloops config
// (isDevLoopConfigSourcePath), reviewer, judge, gate-coordinator and docs agents with their .claude mirror,
// the gate, judge, review, acceptance-criteria, structural-quality, validation-policy, spec-authority and copilot-loop-operations contracts, the copilot-pr-followup, review, dev-loop and local-implementation skills,
// core config (angle, persona, prompt and judge-track resolution), spec-authority.mjs (judge disposition rules), analysis/diff-analyzer.mjs (angle scope and dispatch mode), build-adjacent-bundle.mjs (reviewer input), the scripts (at any depth) and core loop modules
// whose file name holds a gate, fan-in, judge, verdict, carry, review, finding, angle, dispatch,
// cluster, round-cap, prompt, unit-bound, disposition, evidence, checkpoint, convergence or pre-push-delta token, and the installed dev-loops version (package
// manifests). Lockfiles and every other path carry.
// A name token matches as a whole word between "-", "_" or ".", so navigate or preview never hit.
const word = (tokens) => `(?:[^/]*[-_.])?(?:${tokens})(?:[-_.][^/]*)?`;
const OUTCOME_NAME = word("gates?|fanin|fan-in|judge|verdicts?|carry|reviews?|reviewers?|findings?|angles?|dispatch|clusters?|round-cap|prompts?|unit-bound|dispositions?|evidence|checkpoint|convergence|pre-push-delta");
const GATE_TOOLING_RE = new RegExp(
  "^(?:\\.claude/)?(?:agents/(?:review|judge|gate-coordinator|docs)\\.(?:agent\\.)?md" +
    `|skills/docs/${word("gate|judge|review")}\\.md` +
    "|skills/docs/(?:acceptance-criteria-verification|structural-quality|validation-policy|spec-authority-contract|copilot-loop-operations)\\.md" +
    "|skills/(?:copilot-pr-followup|review|dev-loop|local-implementation)/SKILL\\.md)$" +
    `|^scripts/(?:[^/]+/)*${OUTCOME_NAME}$` +
    "|^scripts/github/build-adjacent-bundle\\.mjs$" +
    `|^packages/core/src/loop/${OUTCOME_NAME}$` +
    "|^packages/core/src/(?:loop/spec-authority|analysis/diff-analyzer)\\.mjs$" +
    "|^packages/core/src/config/[^/]+$" +
    "|^package\\.json$|^packages/[^/]+/package\\.json$",
);

export function isGateToolingPath(filePath) {
  if (typeof filePath !== "string") return false;
  const p = filePath.trim().replace(/\\/g, "/");
  return isDevLoopConfigSourcePath(p) || GATE_TOOLING_RE.test(p);
}

const FULL_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const isPathList = (v) => Array.isArray(v) && v.every((p) => typeof p === "string" && p.length > 0);
// A carry needs real facts: a nonempty array of nonempty strings (numbers, booleans, empty strings and empty lists refuse).
const isFactList = (v) => Array.isArray(v) && v.length > 0 && isPathList(v);

/**
 * @param {object} input
 * @param {string} input.sourceHead  previous head A
 * @param {string} input.newHead     new head B
 * @param {string[]} input.prBlobsBefore sorted `path\tmode\toid` of the PR's own tree entries at A (merge-base A..A)
 * @param {string[]} input.prBlobsAfter  the same at B (merge-base B..B)
 * @param {string[]} input.baseDeltaPaths paths the base delta (merge-base A..B) touched
 * @param {boolean} [input.conflictResolutionHunks] true when the merge resolved conflicts
 * @param {string} [input.detectionError] set when computing any input failed
 */
export function classifyBaseMergeCarry(input = {}, { ignoreGateTooling = false } = {}) {
  const { sourceHead, newHead, prBlobsBefore, prBlobsAfter, baseDeltaPaths, conflictResolutionHunks = false, detectionError } = input;
  const evidence = {
    sourceHead: sourceHead ?? null,
    newHead: newHead ?? null,
    prBlobsBefore: prBlobsBefore ?? null,
    prBlobsAfter: prBlobsAfter ?? null,
    prDiffPaths: null,
    baseDeltaPaths: baseDeltaPaths ?? null,
    conflictResolutionHunks: conflictResolutionHunks ?? null,
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
  if (!isFactList(prBlobsBefore) || !isFactList(prBlobsAfter)) return done("fallback_full", "blob facts missing or malformed");
  if (!isPathList(baseDeltaPaths) || typeof conflictResolutionHunks !== "boolean") {
    return done("fallback_full", "malformed path lists");
  }
  // Derived from the blob facts, never trusted as an input: the PR paths at either head.
  evidence.prDiffPaths = [...new Set([...prBlobsBefore, ...prBlobsAfter].map((e) => e.split("\t").slice(0, -2).join("\t")))].sort();
  const prPaths = new Set(evidence.prDiffPaths);
  evidence.pathIntersection = [...new Set(baseDeltaPaths.filter((p) => prPaths.has(p)))].sort();
  evidence.gateToolingPaths = [...new Set(baseDeltaPaths.filter(isGateToolingPath))].sort();

  if (JSON.stringify([...prBlobsBefore].sort()) !== JSON.stringify([...prBlobsAfter].sort())) return done("full_regate", "PR blob changed between heads");
  if (conflictResolutionHunks) return done("full_regate", "merge carries conflict-resolution hunks");
  if (!ignoreGateTooling && evidence.gateToolingPaths.length > 0) return done("full_regate", "base delta touches gate tooling or config");
  if (evidence.pathIntersection.length > 0) return done("full_regate", "base delta overlaps PR paths");
  // The fixer-emit seam (ADR 0156 amendment) skips the tooling rule. Its own reason text keeps that evidence
  // from ever validating under the default rule, so it cannot satisfy gate coordination or merge-pr.
  if (ignoreGateTooling) return done("carry_verdict", "PR blobs identical, no overlap; gate tooling rule ignored (fixer-emit seam)");
  return done("carry_verdict", "PR blobs identical, no overlap, no gate tooling in base delta");
}

/**
 * Consistency check for merge-pr: shape, then the decision and every derived
 * field recomputed from the recorded facts. It rejects an internally inconsistent
 * record only. It never re-derives blob facts or paths from git, so a consumer must
 * re-run computeBaseMergeCarry for the bound heads and compare before trusting the facts.
 * Optional expectedSourceHead and
 * expectedNewHead bind the record to the heads the caller is merging.
 * Returns { ok, reason }.
 */
export function validateBaseMergeCarryEvidence(evidence, { expectedSourceHead, expectedNewHead, ignoreGateTooling = false } = {}) {
  if (!evidence || typeof evidence !== "object") return { ok: false, reason: "evidence missing" };
  const keys = ["sourceHead", "newHead", "prBlobsBefore", "prBlobsAfter", "prDiffPaths", "baseDeltaPaths", "conflictResolutionHunks", "pathIntersection", "gateToolingPaths", "decision", "reason"];
  for (const k of keys) if (!(k in evidence)) return { ok: false, reason: `missing field ${k}` };
  if (!BASE_MERGE_CARRY_DECISIONS.includes(evidence.decision)) return { ok: false, reason: "unknown decision" };
  if (!isPathList(evidence.pathIntersection) || !isPathList(evidence.gateToolingPaths)) return { ok: false, reason: "malformed path lists" };
  if (expectedSourceHead !== undefined && evidence.sourceHead !== expectedSourceHead) return { ok: false, reason: "sourceHead mismatch" };
  if (expectedNewHead !== undefined && evidence.newHead !== expectedNewHead) return { ok: false, reason: "newHead mismatch" };
  if (evidence.decision === "fallback_full") return { ok: true, reason: "" }; // never carries
  const re = classifyBaseMergeCarry(evidence, { ignoreGateTooling });
  if (re.decision !== evidence.decision) return { ok: false, reason: `decision recomputes to ${re.decision}` };
  for (const k of ["prDiffPaths", "pathIntersection", "gateToolingPaths", "reason"]) {
    if (JSON.stringify(re[k]) !== JSON.stringify(evidence[k])) return { ok: false, reason: `${k} does not match recomputed value` };
  }
  return { ok: true, reason: "" };
}
