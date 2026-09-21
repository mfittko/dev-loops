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
 * `findBlockingTitleMarkers` (pr-title-markers), the detect-checkpoint-evidence
 * `preMergeGateCheck` bundle (draft/pre-approval verdicts, threads, runner lock,
 * fan-out provenance), and `classifyCopilotReviewBodyDisposition` (copilot-helpers,
 * the same current-head Copilot disposition detection the loop's
 * `copilotBodyFeedbackUnresolved` reads). This module adds ONLY the
 * human-approver identity, the merge-class split, the Copilot-convergence
 * precondition, and the aggregate naming.
 */

import { isCopilotLogin, classifyCopilotReviewBodyDisposition, COPILOT_DISPOSITION, SUBMITTED_REVIEW_STATES, extractReviewCommitSha } from "../github/copilot-helpers.mjs";
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

// A non-human review/comment author. Beyond the login-shape check, a GitHub Bot
// account carries `user.type === "Bot"` even when its login has no `[bot]`
// suffix — reject it by that authoritative type so a bracket-free bot login can
// never satisfy the named fresh approver.
function isNonHumanAuthor(entry, login) {
  return isNonHumanLogin(login) || (typeof entry?.type === "string" && entry.type.toLowerCase() === "bot");
}

function reviewCommit(entry) {
  if (typeof entry?.commit_id === "string" && entry.commit_id.length > 0) return entry.commit_id;
  if (typeof entry?.commitId === "string" && entry.commitId.length > 0) return entry.commitId;
  return null;
}

// Copilot-only login extraction for evaluateCopilotConvergence: accepts the
// `gh pr view` GraphQL shape (author.login) in addition to the REST shape
// (user.login | login) reviewLogin reads. Scoped to the Copilot-convergence
// eval so verifyFreshHumanApproval's human-approval matching is unchanged.
function copilotConvergenceReviewLogin(entry) {
  if (typeof entry?.author?.login === "string" && entry.author.login.length > 0) return entry.author.login;
  return reviewLogin(entry);
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
    && !isNonHumanAuthor(approverReview, approvedBy) // agent/bot review never satisfies
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
    if (login === null || isNonHumanAuthor(entry, login)) continue; // agent/bot comment never satisfies
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
 * Copilot-convergence merge precondition. Wires the current-head Copilot
 * body-disposition detection into the merge gate so the merge wrapper
 * and the loop (`copilotBodyFeedbackUnresolved`) read the SAME classification
 * (`classifyCopilotReviewBodyDisposition`). The classification is shared, so it
 * cannot drift; the POLICY differs by design (the loop self-blocks on 🔵, this
 * gate treats 🔵 as conductor-overridable). Fail-closed.
 *
 * Only the LATEST Copilot review pinned to `currentHeadSha` is judged, so a
 * stale non-approval at an earlier head never blocks and a later same-head 🟢
 * clears an earlier same-head finding.
 *
 * Policy (operator-resolved during the v1.0.4 drain):
 *   🟡 "Changes recommended" on the current head -> BLOCK (actionable; the review
 *      body is unresolved feedback even with zero inline threads — the exact
 *      body-only fail-open the loop detects and this precondition enforces at merge).
 *   🔵 "Needs a closer look" -> conductor-OVERRIDABLE (soft), NOT blocked here.
 *      Unresolved threads still gate it (detect-checkpoint-evidence refuses any
 *      unresolved review thread), so a 🔵 merges only with zero unresolved
 *      threads — the conductor's override is choosing to run the merge on a
 *      thread-clean 🔵.
 *   unrecognized disposition -> BLOCK (fail closed on a Copilot format change).
 *   🟢 clean / no current-head Copilot review / stale earlier-head -> PASS.
 *
 * @returns {{ ok: boolean, disposition: string|null, reason: string|null }}
 */
export function evaluateCopilotConvergence({ currentHeadSha = null, reviews = [] } = {}) {
  const head = typeof currentHeadSha === "string" ? currentHeadSha.trim() : "";
  // Head unknown: no current-head review can be pinned. Fail closed (matches
  // verifyFreshHumanApproval), so this precondition can never pass without a
  // known head to pin the Copilot disposition to.
  if (head.length === 0) return { ok: false, disposition: null, reason: "current head SHA is unknown; cannot pin a Copilot review to it" };

  // Mirror summarizeCopilotReviews' current-head finding selection BYTE-FOR-BYTE
  // so the merge gate and the loop can never diverge (they already share
  // classifyCopilotReviewBodyDisposition at the detection layer). Use the SAME
  // comparison the loop uses — the RAW submittedAt string (a non-string is null),
  // compared with `>`/`===`, NOT a parsed timestamp: parsing would diverge on a
  // malformed/mixed-offset submittedAt (an invalid-timestamp 🟡 that the loop
  // keeps as latest could otherwise be superseded here — a fail-open). Consider
  // only SUBMITTED current-head reviews, skip PENDING drafts (a PENDING never
  // sets the finding), pick the latest by submittedAt string, and on an
  // equal-string tie (or both-null) fold toward the most-blocking disposition so
  // array order never silently drops a finding.
  let latestDisposition = null;
  let latestAt = null;
  for (const entry of Array.isArray(reviews) ? reviews : []) {
    // Shape-tolerant Copilot-login + commit extraction: the merge gate feeds
    // REST-shaped reviews (user.login/commit_id) while the gate-ENTRY detector
    // feeds `gh pr view` GraphQL-shaped reviews (author.login/commit.oid). Both
    // call sites route through this one evaluateCopilotConvergence, so it must
    // recognize BOTH shapes to produce ONE convergence verdict. Only Copilot
    // reviews matter here, so broadening the login read to author.login cannot
    // affect verifyFreshHumanApproval (which keeps its own REST-only
    // reviewLogin/reviewCommit).
    const login = copilotConvergenceReviewLogin(entry);
    if (login === null || !isCopilotLogin(login)) continue;
    if (extractReviewCommitSha(entry) !== head) continue; // only current-head reviews
    const state = typeof entry?.state === "string" ? entry.state.toUpperCase() : "";
    if (state === "PENDING" || !SUBMITTED_REVIEW_STATES.has(state)) continue; // PENDING/unknown never sets the finding
    const disposition = classifyCopilotReviewBodyDisposition(state, entry?.body);
    const submittedAt = typeof entry?.submittedAt === "string"
      ? entry.submittedAt
      : (typeof entry?.submitted_at === "string" ? entry.submitted_at : null);
    if (submittedAt !== null && (latestAt === null || submittedAt > latestAt)) {
      latestDisposition = disposition; // a lexicographically-later submittedAt supersedes (matches summarize)
      latestAt = submittedAt;
    } else if (submittedAt !== null && submittedAt === latestAt) {
      latestDisposition = latestDisposition === null ? disposition : moreBlockingDisposition(latestDisposition, disposition);
    } else if (submittedAt === null && latestAt === null) {
      latestDisposition = latestDisposition === null ? disposition : moreBlockingDisposition(latestDisposition, disposition);
    }
    // a null submittedAt once a non-null latest exists is ignored (mirrors summarize)
  }
  if (latestDisposition === null) return { ok: true, disposition: null, reason: null };

  if (latestDisposition === COPILOT_DISPOSITION.CHANGES_RECOMMENDED) {
    return { ok: false, disposition: latestDisposition, reason: `current-head Copilot review is "Changes recommended" (🟡, actionable non-approval); converge to "Approval recommended" (🟢) or resolve the feedback before merge` };
  }
  if (latestDisposition === COPILOT_DISPOSITION.UNRECOGNIZED) {
    return { ok: false, disposition: latestDisposition, reason: `current-head Copilot review carries an unrecognized disposition header (fail closed); a recognized "Approval recommended" (🟢) is required` };
  }
  // CLEAN, NONE, and NEEDS_CLOSER_LOOK (🔵, conductor-overridable) pass.
  return { ok: true, disposition: latestDisposition, reason: null };
}

// Disposition blocking precedence, most-blocking first. Used to fold an
// equal-timestamp same-head tie toward the most-blocking disposition so a tied
// 🟡/unrecognized is never silently dropped by a co-timestamped 🟢/🔵.
const COPILOT_DISPOSITION_BLOCKING_ORDER = [
  COPILOT_DISPOSITION.CHANGES_RECOMMENDED,
  COPILOT_DISPOSITION.UNRECOGNIZED,
  COPILOT_DISPOSITION.NEEDS_CLOSER_LOOK,
  COPILOT_DISPOSITION.CLEAN,
  COPILOT_DISPOSITION.NONE,
];
function moreBlockingDisposition(a, b) {
  const ia = COPILOT_DISPOSITION_BLOCKING_ORDER.indexOf(a);
  const ib = COPILOT_DISPOSITION_BLOCKING_ORDER.indexOf(b);
  // A value absent from the order (defensive) sorts last.
  const ra = ia === -1 ? COPILOT_DISPOSITION_BLOCKING_ORDER.length : ia;
  const rb = ib === -1 ? COPILOT_DISPOSITION_BLOCKING_ORDER.length : ib;
  return ra <= rb ? a : b;
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
 * not. An empty or no-CI rollup normalizes to `none`, which is NOT green (a PR
 * with no visible CI does not auto-satisfy this precondition).
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
  // Default null (not false): a missing/absent T1 signal must reach
  // resolveSizeBudgetHumanApprovalRequired as a non-boolean so it fails closed,
  // rather than being coerced to "T1 untouched".
  touchesT1 = null,
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

  // Fail closed on anything but an explicit { green: true } — a `false`, null, or
  // malformed ciGreen must NOT slip past this fail-closed aggregate.
  if (!ciGreen || ciGreen.green !== true) {
    failures.push({ precondition: "ci_green", reason: (ciGreen && ciGreen.reason) ? ciGreen.reason : "CI status could not be resolved for the current head" });
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

  // Computed once, ahead of the size gate, so both preconditions draw "valid
  // human approval" from the one shared resolver instead of two divergent
  // checks (verifyFreshHumanApproval already owns the comment token, head
  // pinning, and bot exclusion; the size gate no longer re-derives it from
  // reviewDecision alone).
  const freshApproval = verifyFreshHumanApproval({ approvedBy: humanApprovedBy, currentHeadSha, reviews, comments });

  if (resolveSizeBudgetHumanApprovalRequired({ sizeOutcome, touchesT1, humanApprovalSatisfied: freshApproval.satisfied, unresolvedChangesRequestedCount }) === true) {
    failures.push({ precondition: "size_budget_human_approval", reason: "size-budget requires a human APPROVED review OR a head-pinned \"approve merge <headSha>\" operator comment, with zero unresolved CHANGES_REQUESTED, for this escalated/T1 PR" });
  }

  // Copilot-convergence precondition: refuse a current-head Copilot non-approval
  // body disposition, mirroring the loop's copilotBodyFeedbackUnresolved.
  const copilotConvergence = evaluateCopilotConvergence({ currentHeadSha, reviews });
  if (!copilotConvergence.ok) {
    failures.push({ precondition: "copilot_convergence", reason: copilotConvergence.reason });
  }

  const mergeClass = resolveMergeClass({ sizeOutcome, touchesT1, stableRelease });
  const decision = resolveMergeApprovalDecision({ mergeClass, standingAuthorized, freshApproval });
  if (!decision.authorized) {
    failures.push({ precondition: "merge_approval", reason: decision.reason });
  }

  return {
    ok: failures.length === 0,
    failures,
    mergeClass,
    approvalVia: decision.authorized ? decision.via : null,
    // Audit trace: the current-head Copilot disposition this verdict saw, so a
    // merge that ran on a conductor-overridable 🔵 (or any disposition) is
    // recorded on the machine-readable result rather than being invisible.
    copilotDisposition: copilotConvergence.disposition,
  };
}
