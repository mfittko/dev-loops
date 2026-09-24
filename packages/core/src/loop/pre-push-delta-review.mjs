/**
 * pre-push-delta-review.mjs: deterministic checks for the pre-push reviewer's
 * delta mode (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-* rules).
 *
 * Delta mode runs one fresh reviewer between the gate fixer's commit of a
 * judge act-list fix and its push. This module owns the trigger predicate, the
 * pinned-baseline sequence, the neutral delta input, the result validator, the
 * exit/bound decision and the freshness check.
 *
 * Pure and offline: no file reads, no git, no network. A delta result is local
 * evidence only; nothing here writes a gate artifact, comment or thread.
 */
import { createHash } from "node:crypto";

import { severityRank, VALID_SEVERITIES, normalizeSeverity } from "./gate-fanin.mjs";

/** At most this many delta review invocations per sequence. */
export const DELTA_MAX_INVOCATIONS = 3;

export const DELTA_ITEM_STATUSES = Object.freeze(["resolved", "not_resolved", "cannot_verify"]);
export const DELTA_OUTCOMES = Object.freeze(["locally_clear", "needs_fix", "bounded_out"]);

/** The adversarial-enumeration checklist floor, shared with full mode. */
export const DELTA_CHECKLIST = Object.freeze([
  "errno classes (missing, permission, not-a-directory, already-exists)",
  "symlink handling for both a file target and a directory target",
  "rename and move across the seam",
  "empty input and empty file",
  "malformed input",
  "path normalization (relative, absolute, .., trailing slash)",
]);

const MEDIUM_RANK = severityRank("medium");

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Trigger predicate. Delta mode runs only for a committed, not yet pushed fix
 * of a non-empty judge act list. Every other push gets no delta review.
 * @param {{ actItemCount?: number, fixCommitted?: boolean, fixPushed?: boolean }} input
 * @returns {"delta"|"none"}
 */
export function resolveDeltaTrigger({ actItemCount = 0, fixCommitted = false, fixPushed = false } = {}) {
  return Number.isInteger(actItemCount) && actItemCount > 0 && fixCommitted === true && fixPushed !== true
    ? "delta"
    : "none";
}

/**
 * Reduce a judge act list (the `judge-pass --out` array) to the neutral act
 * items the reviewer may see. Only allow-listed fields pass, so reviewer
 * verdicts, "clean" claims and diff bytes never reach the delta input.
 * @param {unknown} actList
 */
export function toDeltaActItems(actList) {
  if (!Array.isArray(actList) || actList.length === 0) {
    throw new Error("delta review requires a non-empty judge act list");
  }
  return actList.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`act list entry ${index} is not an object`);
    if (entry.judgeDisposition !== "act") {
      throw new Error(`act list entry ${index} has judgeDisposition ${JSON.stringify(entry.judgeDisposition)}, expected "act"`);
    }
    const item = {
      ref: nonEmpty(entry.ref) ? entry.ref.trim() : `act-${index + 1}`,
      angle: nonEmpty(entry.angle) ? entry.angle.trim() : null,
      severity: normalizeSeverity(entry.severity) ?? null,
      summary: nonEmpty(entry.summary) ? entry.summary.trim() : "",
      judgeDisposition: "act",
    };
    if (nonEmpty(entry.judgeRationale)) item.judgeRationale = entry.judgeRationale.trim();
    if (nonEmpty(entry.file)) item.file = entry.file.trim();
    if (Number.isInteger(entry.line)) item.line = entry.line;
    return item;
  });
}

/**
 * Open a delta sequence for one gate round. The baseline is the head that gate
 * round reviewed and stays pinned for every invocation in the sequence; a new
 * gate round opens a new sequence.
 * @param {{ reviewBaselineHead: string, actList: unknown }} input
 */
export function startDeltaSequence({ reviewBaselineHead, actList } = {}) {
  if (!nonEmpty(reviewBaselineHead)) throw new Error("delta sequence requires reviewBaselineHead");
  const actItems = toDeltaActItems(actList);
  const actSetId = createHash("sha256")
    .update(JSON.stringify(actItems.map(({ ref, summary }) => [ref, summary])))
    .digest("hex")
    .slice(0, 16);
  return Object.freeze({ reviewBaselineHead: reviewBaselineHead.trim(), actSetId, actItems });
}

/**
 * Build the reviewer input for one invocation. The range is always
 * `reviewBaselineHead..candidateHead` (cumulative), never the last fix only.
 * The reviewer reads the diff from the worktree; the input carries no diff.
 * @param {{ sequence: ReturnType<typeof startDeltaSequence>, candidateHead: string, specIdentity?: string|null }} input
 */
export function buildDeltaInput({ sequence, candidateHead, specIdentity = null } = {}) {
  if (!sequence || !nonEmpty(sequence.reviewBaselineHead)) throw new Error("buildDeltaInput requires a delta sequence");
  if (!nonEmpty(candidateHead)) throw new Error("buildDeltaInput requires candidateHead");
  const head = candidateHead.trim();
  return {
    mode: "delta",
    reviewBaselineHead: sequence.reviewBaselineHead,
    candidateHead: head,
    diffRange: `${sequence.reviewBaselineHead}..${head}`,
    actSetId: sequence.actSetId,
    actItems: sequence.actItems.map((item) => ({ ...item })),
    specIdentity: nonEmpty(specIdentity) ? specIdentity.trim() : null,
    surfaceHints: [...new Set(sequence.actItems.map((item) => item.angle).filter(Boolean))],
    checklist: [...DELTA_CHECKLIST],
  };
}

/**
 * The outcome the item statuses and new findings imply: locally_clear only when
 * every act item is resolved and no new finding is medium or higher.
 * @param {{ actionableItems?: Array<{status?: string}>, newFindings?: Array<{severity?: string}> }} result
 * @returns {"locally_clear"|"needs_fix"}
 */
export function deriveDeltaOutcome(result) {
  const items = Array.isArray(result?.actionableItems) ? result.actionableItems : [];
  const findings = Array.isArray(result?.newFindings) ? result.newFindings : [];
  const allResolved = items.length > 0 && items.every((item) => item?.status === "resolved");
  const blockingFinding = findings.some((f) => severityRank(f?.severity) <= MEDIUM_RANK);
  return allResolved && !blockingFinding ? "locally_clear" : "needs_fix";
}

/**
 * Validate a DeltaPrePushReviewResult against its sequence. Returns the list of
 * problems; an empty list means the result is well formed.
 * @param {unknown} result
 * @param {{ sequence: ReturnType<typeof startDeltaSequence> }} context
 * @returns {string[]}
 */
export function validateDeltaResult(result, { sequence } = {}) {
  const errors = [];
  if (!result || typeof result !== "object") return ["result must be an object"];
  if (result.reviewBaselineHead !== sequence?.reviewBaselineHead) {
    errors.push(`reviewBaselineHead ${JSON.stringify(result.reviewBaselineHead)} does not match the pinned baseline ${JSON.stringify(sequence?.reviewBaselineHead)}`);
  }
  if (!nonEmpty(result.candidateHead)) errors.push("candidateHead is required");

  const items = Array.isArray(result.actionableItems) ? result.actionableItems : null;
  if (!items) errors.push("actionableItems[] is required");
  const expectedRefs = new Set((sequence?.actItems ?? []).map((item) => item.ref));
  const seen = new Set();
  for (const [i, item] of (items ?? []).entries()) {
    if (!expectedRefs.has(item?.ref)) errors.push(`actionableItems[${i}].ref ${JSON.stringify(item?.ref)} is not in the act set`);
    else seen.add(item.ref);
    if (item?.status === undefined) errors.push(`actionableItems[${i}].status is missing`);
    else if (!DELTA_ITEM_STATUSES.includes(item.status)) errors.push(`actionableItems[${i}].status ${JSON.stringify(item.status)} is unknown`);
    if (!Array.isArray(item?.evidence) || item.evidence.length === 0) errors.push(`actionableItems[${i}].evidence[] must be non-empty`);
  }
  for (const ref of expectedRefs) if (!seen.has(ref)) errors.push(`act item ${ref} has no status`);

  const findings = Array.isArray(result.newFindings) ? result.newFindings : null;
  if (!findings) errors.push("newFindings[] is required");
  for (const [i, f] of (findings ?? []).entries()) {
    if (!VALID_SEVERITIES.has(normalizeSeverity(f?.severity))) errors.push(`newFindings[${i}].severity ${JSON.stringify(f?.severity)} is unknown`);
    if (!nonEmpty(f?.summary)) errors.push(`newFindings[${i}].summary is required`);
  }

  if (!Array.isArray(result.widenedReads)) errors.push("widenedReads[] is required (empty when nothing was widened)");
  else for (const [i, read] of result.widenedReads.entries()) {
    if (!nonEmpty(read?.path) || !nonEmpty(read?.reason)) errors.push(`widenedReads[${i}] needs a path and a reason`);
  }

  if (!DELTA_OUTCOMES.includes(result.outcome)) errors.push(`outcome ${JSON.stringify(result.outcome)} is unknown`);
  else if (result.outcome === "locally_clear" && deriveDeltaOutcome(result) !== "locally_clear") {
    errors.push("locally_clear requires every act item resolved and no new finding of severity medium or higher");
  }
  return errors;
}

/**
 * Freshness: a result authorizes a push only for the head it reviewed.
 * @param {{ candidateHead?: string }} result
 * @param {string} currentHead the worktree HEAD read just before the push
 */
export function isDeltaResultFresh(result, currentHead) {
  return nonEmpty(result?.candidateHead) && nonEmpty(currentHead) && result.candidateHead.trim() === currentHead.trim();
}

/**
 * Decide the next step after invocation `invocation` (1-based) of a sequence.
 * - fresh, valid, locally_clear: push.
 * - otherwise, below the bound: fix (or re-review a moved head) and review again.
 * - otherwise, at the bound: bounded_out; push the committed candidate into the
 *   normal gate path with the residual evidence. No fourth review runs.
 * @param {{ sequence: ReturnType<typeof startDeltaSequence>, result: unknown, invocation: number, currentHead: string }} input
 */
export function decideDeltaNextStep({ sequence, result, invocation, currentHead } = {}) {
  if (!Number.isInteger(invocation) || invocation < 1 || invocation > DELTA_MAX_INVOCATIONS) {
    throw new Error(`invocation must be an integer in 1..${DELTA_MAX_INVOCATIONS}`);
  }
  const errors = validateDeltaResult(result, { sequence });
  const fresh = isDeltaResultFresh(/** @type {any} */ (result), currentHead);
  const clear = errors.length === 0 && fresh && /** @type {any} */ (result).outcome === "locally_clear";
  if (clear) return { outcome: "locally_clear", nextStep: "push", locallyClear: true, errors, fresh };
  if (invocation >= DELTA_MAX_INVOCATIONS) {
    return { outcome: "bounded_out", nextStep: "push_to_gate", locallyClear: false, errors, fresh };
  }
  return {
    outcome: "needs_fix",
    nextStep: fresh ? "fix_and_rereview" : "rereview_current_head",
    locallyClear: false,
    errors,
    fresh,
  };
}
