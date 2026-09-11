/**
 * Sanctioned merge-wrapper decision logic. Pure, no I/O.
 *
 * The CLI wrapper `scripts/github/merge-pr.mjs` gathers live GitHub facts
 * (mergeable state, CI rollup, gate evidence, size-budget outcome, reviews,
 * comments) and feeds them here. This module owns the FAIL-CLOSED decisions:
 *   - is `--human-approved-by` a real GitHub login;
 *   - which merge class the PR is in (drain vs escalated);
 *   - whether a fresh, agent-unforgeable, head-pinned human approval exists;
 *   - and the aggregate precondition verdict that names each failing precondition.
 *
 * It reuses, never re-derives, the existing precondition set:
 * `resolveSizeBudgetHumanApprovalRequired` (size-budget-merge-gate),
 * `findBlockingTitleMarkers` (pr-title-markers), and the detect-checkpoint-evidence
 * `preMergeGateCheck` bundle (draft/pre-approval verdicts, threads, runner lock,
 * fan-out provenance). This module adds ONLY the human-approver identity, the
 * merge-class split, and the aggregate naming.
 */

import { isCopilotLogin } from "../github/copilot-helpers.mjs";
import { findBlockingTitleMarkers } from "./pr-title-markers.mjs";
import { resolveSizeBudgetHumanApprovalRequired } from "./size-budget-merge-gate.mjs";
import { deriveLoopCiStatusFromRollup } from "./copilot-ci-status.mjs";

// A GitHub login: 1-39 chars, alphanumeric or single internal hyphens, never
// leading/trailing hyphen. This rejects a bare boolean, empty/whitespace, and
// free text, so `--human-approved-by` is a real login, not a boolean or free text.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/;

/** True when `login` is shaped like a real GitHub login (fails closed on non-string). */
export function isValidGithubLogin(login) {
  return typeof login === "string" && login.length >= 1 && login.length <= 39 && GITHUB_LOGIN_RE.test(login);
}

export const MERGE_CLASS = Object.freeze({ DRAIN: "drain", ESCALATED: "escalated" });

/**
 * Classify the merge. An `escalate`/`block` size outcome, a T1-touching diff,
 * or an explicit stable-release merge is ESCALATED — a standing authorization
 * never satisfies it; it needs a fresh per-merge operator approval. Everything
 * else is a normal DRAIN merge.
 */
export function resolveMergeClass({ sizeOutcome = null, touchesT1 = false, stableRelease = false } = {}) {
  if (stableRelease === true) return MERGE_CLASS.ESCALATED;
  if (sizeOutcome === "escalate" || sizeOutcome === "block") return MERGE_CLASS.ESCALATED;
  if (touchesT1 === true) return MERGE_CLASS.ESCALATED;
  return MERGE_CLASS.DRAIN;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reviewLogin(entry) {
  if (typeof entry?.user?.login === "string" && entry.user.login.length > 0) return entry.user.login;
  if (typeof entry?.login === "string" && entry.login.length > 0) return entry.login;
  return null;
}

// A non-human login: the Copilot reviewer/bot (bracket-free `Copilot`
// variants, caught by isCopilotLogin) or any GitHub App bot login, which
// GitHub renders with a `[bot]` suffix (e.g. `github-actions[bot]`). Such a
// login can never satisfy the human-approval requirement. (A `[bot]` login can
// never be the named `--human-approved-by <login>` either — isValidGithubLogin
// rejects the brackets — so this only ever fires on a review/comment AUTHOR.)
function isNonHumanLogin(login) {
  return isCopilotLogin(login) || /\[bot\]$/i.test(login);
}

function reviewCommit(entry) {
  if (typeof entry?.commit_id === "string" && entry.commit_id.length > 0) return entry.commit_id;
  if (typeof entry?.commitId === "string" && entry.commitId.length > 0) return entry.commitId;
  return null;
}

/**
 * Verify a fresh, agent-unforgeable, head-pinned human approval by `approvedBy`.
 *
 * Two accepted records, in preference order:
 *  1. a genuine `APPROVED` review by `approvedBy` whose `commit_id` equals the
 *     current head SHA — GitHub forbids approving your own PR, so an `APPROVED`
 *     review can only have come from a real human distinct from the author;
 *  2. else a head-pinned operator comment marker `approve merge <headSha>`
 *     authored by `approvedBy` — the solo-operator path, since an author cannot
 *     leave an `APPROVED` review on their own agent-authored PR.
 *
 * FAILS CLOSED (returns `{ satisfied: false }`) when the approval is stale (on
 * an earlier commit), agent/bot-authored (a Copilot-login review/comment never
 * satisfies), from a login other than `approvedBy`, or absent. Because both
 * records are pinned to the current head SHA, this re-gates on every head bump.
 *
 * @returns {{ satisfied: boolean, via: "approved_review"|"comment_marker"|null, reason: string|null }}
 */
export function verifyFreshHumanApproval({ approvedBy, currentHeadSha, reviews = [], comments = [] } = {}) {
  if (!isValidGithubLogin(approvedBy)) {
    return { satisfied: false, via: null, reason: "approvedBy is not a valid GitHub login" };
  }
  if (typeof currentHeadSha !== "string" || currentHeadSha.trim().length === 0) {
    return { satisfied: false, via: null, reason: "current head SHA is unknown" };
  }
  const head = currentHeadSha.trim();

  // Reduce to each login's LATEST submitted review (reviews arrive oldest-first,
  // so the last occurrence wins — matching resolveHumanReviewDecision). A login
  // whose APPROVED review was later superseded by a COMMENTED / CHANGES_REQUESTED
  // / DISMISSED review no longer satisfies: only their latest state counts.
  const latestReviewByLogin = new Map();
  for (const entry of Array.isArray(reviews) ? reviews : []) {
    const login = reviewLogin(entry);
    if (login === null) continue;
    latestReviewByLogin.set(login, entry);
  }
  const approverReview = latestReviewByLogin.get(approvedBy);
  if (
    approverReview
    && !isNonHumanLogin(approvedBy) // agent/bot review never satisfies
    && (typeof approverReview.state === "string" ? approverReview.state : null) === "APPROVED"
    && reviewCommit(approverReview) === head // head-pinned — a stale/earlier-commit approval never satisfies
  ) {
    return { satisfied: true, via: "approved_review", reason: null };
  }

  // The marker must OPEN its line (after only leading whitespace / list / quote
  // markers) so a negating operator comment never reads as approval: an
  // unanchored `approve merge <head>` would also match `disapprove merge <head>`
  // and `not approve merge <head>` — a fail-open on the merge-authorization
  // path. The trailing `(?:\b|$)` keeps `<head>abc` from matching `<head>`.
  const markerRe = new RegExp(`^[ \\t>*-]*approve\\s+merge\\s+${escapeRegex(head)}(?:\\b|$)`, "im");
  for (const entry of Array.isArray(comments) ? comments : []) {
    const login = reviewLogin(entry);
    const body = typeof entry?.body === "string" ? entry.body : "";
    if (login === null || isNonHumanLogin(login)) continue; // agent/bot comment never satisfies
    if (login !== approvedBy) continue; // wrong login
    if (!markerRe.test(body)) continue; // not a head-pinned marker for this head
    return { satisfied: true, via: "comment_marker", reason: null };
  }

  return {
    satisfied: false,
    via: null,
    reason: `no fresh ${approvedBy} approval on head ${head} (need an APPROVED review or an "approve merge ${head}" operator comment)`,
  };
}

/**
 * Decide whether merge is authorized given the class, the standing
 * authorization signal, and any fresh per-merge approval.
 *
 * DRAIN: satisfied by a recorded standing authorization OR a fresh approval.
 * ESCALATED: a standing authorization does NOT satisfy it — a fresh per-merge
 * operator approval is required.
 *
 * @returns {{ authorized: boolean, via: string|null, reason: string|null }}
 */
export function resolveMergeApprovalDecision({ mergeClass, standingAuthorized = false, freshApproval = null } = {}) {
  const fresh = freshApproval != null && freshApproval.satisfied === true;
  if (mergeClass === MERGE_CLASS.ESCALATED) {
    if (fresh) return { authorized: true, via: freshApproval.via, reason: null };
    return {
      authorized: false,
      via: null,
      reason: `escalated/stable-release merge requires a fresh per-merge operator approval; a standing authorization does not satisfy it${freshApproval?.reason ? ` (${freshApproval.reason})` : ""}`,
    };
  }
  if (standingAuthorized === true) return { authorized: true, via: "standing_authorization", reason: null };
  if (fresh) return { authorized: true, via: freshApproval.via, reason: null };
  return {
    authorized: false,
    via: null,
    reason: `drain merge requires a recorded standing authorization or a fresh operator approval${freshApproval?.reason ? ` (${freshApproval.reason})` : ""}`,
  };
}

/**
 * Resolve CI-green from a `gh pr view --json statusCheckRollup` payload.
 *
 * Delegates to the canonical loop-safe normalizer `deriveLoopCiStatusFromRollup`,
 * which EXCLUDES the loop-derived `gate-evidence` / `gate-evidence-runner` checks
 * (detect-checkpoint-evidence validates those separately, so a cancelled/failing
 * derived check must not block a merge whose real CI is green) and treats a
 * completed-but-no-conclusion or otherwise-unreadable entry as non-success.
 * Fails closed: only a real `success` is green; pending/failure/unavailable are
 * not. An empty rollup (no required checks) is green.
 */
export function resolveCiGreenFromRollup(rollup) {
  if (!Array.isArray(rollup)) return { green: false, reason: "CI status rollup unavailable" };
  const { status, excludedFailureDetails } = deriveLoopCiStatusFromRollup(rollup);
  if (status === "success") return { green: true, reason: null };
  return {
    green: false,
    reason: `CI is not green on the current head (status=${status})`,
    ...(Array.isArray(excludedFailureDetails) && excludedFailureDetails.length > 0 ? { excludedFailureDetails } : {}),
  };
}

/**
 * Aggregate every merge precondition into one fail-closed verdict, naming the
 * specific failing precondition(s). The CLI resolves the live facts and passes
 * them in; this stays pure so each branch is unit-testable.
 *
 * @returns {{ ok: boolean, failures: Array<{ precondition: string, reason: string }>, mergeClass: string, approvalVia: string|null }}
 */
export function evaluateMergePreconditions({
  humanApprovedBy,
  mergeable = null,
  mergeStateStatus = null,
  ciGreen = null,
  title = null,
  gateEvidence = null,
  sizeOutcome = null,
  touchesT1 = false,
  humanReviewDecision = null,
  unresolvedChangesRequestedCount = null,
  currentHeadSha = null,
  reviews = [],
  comments = [],
  standingAuthorized = false,
  stableRelease = false,
} = {}) {
  const failures = [];

  if (!isValidGithubLogin(humanApprovedBy)) {
    failures.push({ precondition: "human_approver", reason: "--human-approved-by must be a real GitHub login (not empty, a boolean, or free text)" });
  }

  if (mergeable !== "MERGEABLE" || (typeof mergeStateStatus === "string" && ["DIRTY", "BEHIND", "UNKNOWN"].includes(mergeStateStatus.toUpperCase()))) {
    failures.push({ precondition: "mergeable", reason: `PR is not conflict-free with base (mergeable=${mergeable ?? "unknown"}, mergeStateStatus=${mergeStateStatus ?? "unknown"}); expected mergeable=MERGEABLE` });
  }

  if (ciGreen && ciGreen.green !== true) {
    failures.push({ precondition: "ci_green", reason: ciGreen.reason ?? "CI is not green on the current head" });
  } else if (ciGreen == null) {
    failures.push({ precondition: "ci_green", reason: "CI status could not be resolved for the current head" });
  }

  // findBlockingTitleMarkers returns [] for a non-string title, so an absent or
  // malformed title payload would silently pass this fail-closed gate — refuse it.
  if (typeof title !== "string" || title.trim().length === 0) {
    failures.push({ precondition: "title_markers", reason: "PR title is missing or unreadable; cannot verify it is free of merge-blocking markers" });
  } else {
    const titleMarkers = findBlockingTitleMarkers(title);
    if (titleMarkers.length > 0) {
      failures.push({ precondition: "title_markers", reason: `PR title carries merge-blocking marker(s): ${titleMarkers.join(", ")}` });
    }
  }

  if (!gateEvidence || gateEvidence.ok !== true) {
    const reason = gateEvidence && Array.isArray(gateEvidence.failures) && gateEvidence.failures.length > 0
      ? gateEvidence.failures.join("; ")
      : "draft_gate / current-head pre_approval_gate evidence is missing or unverified";
    failures.push({ precondition: "gate_evidence", reason });
  }

  if (resolveSizeBudgetHumanApprovalRequired({ sizeOutcome, touchesT1, reviewDecision: humanReviewDecision, unresolvedChangesRequestedCount }) === true) {
    failures.push({ precondition: "size_budget_human_approval", reason: "size-budget requires a human APPROVED review with zero unresolved CHANGES_REQUESTED for this escalated/T1 PR" });
  }

  const mergeClass = resolveMergeClass({ sizeOutcome, touchesT1, stableRelease });
  const freshApproval = verifyFreshHumanApproval({ approvedBy: humanApprovedBy, currentHeadSha, reviews, comments });
  const decision = resolveMergeApprovalDecision({ mergeClass, standingAuthorized, freshApproval });
  if (!decision.authorized) {
    failures.push({ precondition: "merge_approval", reason: decision.reason });
  }

  return { ok: failures.length === 0, failures, mergeClass, approvalVia: decision.authorized ? decision.via : null };
}
