/**
 * Size-budget-driven human-approval-required merge gate (phase 3 of the
 * fail-closed PR size budget). Pure, no I/O: consumes an
 * already-resolved size-budget outcome (see check-size-budget.mjs's
 * computeSizeBudget/evaluatePrSizeBudget — this module never recomputes it)
 * plus a human-scoped review decision, and decides whether merge must wait
 * for a human APPROVED review with zero unresolved CHANGES_REQUESTED.
 *
 * This gate is consulted IN ADDITION TO resolveEffectiveMergeAuthorized /
 * humanMergeOnly (@dev-loops/core/config) — never instead of, and never as a
 * relaxation. A `pass` outcome that never touches the T1 tier carries no
 * size-imposed requirement at all; normal merge authorization applies
 * unchanged.
 */

import { SUBMITTED_REVIEW_STATES, isCopilotLogin } from "../github/copilot-helpers.mjs";

const VALID_SIZE_OUTCOMES = new Set(["pass", "escalate", "block"]);

/**
 * Resolve whether an escalated/T1 PR's merge must wait for a human APPROVED
 * review with zero unresolved CHANGES_REQUESTED.
 *
 * FAILS CLOSED: an unreadable `sizeOutcome`, a non-boolean `touchesT1`, a
 * `reviewDecision` that is not exactly `"APPROVED"`, or a non-zero/unreadable
 * `unresolvedChangesRequestedCount` all require human approval (return
 * `true`). A `pass` outcome that never touches the T1 tier returns `false`
 * (no size-imposed requirement).
 *
 * `sizeOutcome === "block"` is treated at least as strictly as `"escalate"`:
 * the issue's own wording names only "escalated or T1", but a block outcome
 * reaching this gate (e.g. new commits landed T1-heavy code after an earlier
 * `pass`/`escalate` draft-gate check) must never require LESS than escalate
 * does.
 *
 * `reviewDecision` MUST already be scoped to human reviewers only — see
 * {@link resolveHumanReviewDecision}, which derives it from raw PR reviews
 * and treats a Copilot review as never satisfying it.
 *
 * `touchesT1` is unprefixed here, but the persisted verdict field a caller
 * would source it from is size-namespaced (`sizeTouchesT1` in
 * copilot-helpers.mjs's detect-checkpoint-evidence output) — a caller wiring
 * that evidence in MUST remap the field name, not spread it as-is.
 *
 * @param {{
 *   sizeOutcome?: "pass"|"escalate"|"block"|null,
 *   touchesT1?: boolean,
 *   reviewDecision?: "APPROVED"|"CHANGES_REQUESTED"|null,
 *   unresolvedChangesRequestedCount?: number,
 * }} [input]
 * @returns {boolean}
 */
export function resolveSizeBudgetHumanApprovalRequired({
  sizeOutcome,
  touchesT1,
  reviewDecision,
  unresolvedChangesRequestedCount,
} = {}) {
  if (!VALID_SIZE_OUTCOMES.has(sizeOutcome)) return true; // size evidence absent/unreadable
  if (typeof touchesT1 !== "boolean") return true; // T1-touch signal missing/unreadable

  const requiresEscalatedReview = sizeOutcome === "escalate" || sizeOutcome === "block" || touchesT1 === true;
  if (!requiresEscalatedReview) return false; // pass, T1 untouched — no size-imposed requirement

  if (reviewDecision !== "APPROVED") return true; // absent / CHANGES_REQUESTED / Copilot-only / unknown
  if (typeof unresolvedChangesRequestedCount !== "number" || unresolvedChangesRequestedCount !== 0) return true;
  return false;
}

/**
 * Reduce raw PR reviews to each human login's LATEST submitted state,
 * excluding the Copilot bot login entirely (a Copilot review can never
 * satisfy or block this gate) and any state outside
 * {@link SUBMITTED_REVIEW_STATES} (e.g. a review payload that already
 * dropped to a bare object). Reviews are assumed ordered oldest-first (the
 * order GitHub's REST/GraphQL review lists are returned in), so the last
 * occurrence of a login wins.
 *
 * @param {Array<{ login?: string, state?: string }>} reviews
 * @returns {Map<string, string>}
 */
function latestHumanReviewStatesByLogin(reviews) {
  const latestByLogin = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const login = typeof review?.login === "string" ? review.login : null;
    const state = typeof review?.state === "string" ? review.state : null;
    if (!login || !state || isCopilotLogin(login) || !SUBMITTED_REVIEW_STATES.has(state)) continue;
    latestByLogin.set(login, state);
  }
  return latestByLogin;
}

/**
 * Derive a human-scoped review decision from raw PR reviews, so a Copilot
 * review can never satisfy {@link resolveSizeBudgetHumanApprovalRequired}'s
 * `reviewDecision === "APPROVED"` check. A CHANGES_REQUESTED from any human
 * login wins over an APPROVED from another (matching GitHub's own
 * reviewDecision semantics: any outstanding requested change blocks).
 *
 * @param {Array<{ login?: string, state?: string }>} reviews
 * @returns {"APPROVED"|"CHANGES_REQUESTED"|null}
 */
export function resolveHumanReviewDecision(reviews) {
  const states = [...latestHumanReviewStatesByLogin(reviews).values()];
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.includes("APPROVED")) return "APPROVED";
  return null;
}

/**
 * Count human logins whose LATEST submitted review is CHANGES_REQUESTED (a
 * login who later re-reviewed with APPROVED/COMMENTED, superseding their own
 * earlier CHANGES_REQUESTED, does not count). Copilot is excluded.
 *
 * @param {Array<{ login?: string, state?: string }>} reviews
 * @returns {number}
 */
export function countUnresolvedHumanChangesRequested(reviews) {
  const states = [...latestHumanReviewStatesByLogin(reviews).values()];
  return states.filter((state) => state === "CHANGES_REQUESTED").length;
}
