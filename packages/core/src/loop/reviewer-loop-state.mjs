/**
 * Deterministic state machine and bounded planning/merge contracts for reviewer-side PR loops.
 */
import { SUBMITTED_REVIEW_STATES } from "../github/copilot-helpers.mjs";
import { trimmedOrNull } from "./normalize.mjs";

export const REVIEWER_STATE = Object.freeze({
  WAITING_FOR_REVIEW_REQUEST: "waiting_for_review_request",
  REVIEW_REQUESTED: "review_requested",
  DETERMINE_REVIEW_PLAN: "determine_review_plan",
  REVIEWS_RUNNING: "reviews_running",
  MERGE_RESULTS: "merge_results",
  DRAFT_REVIEW_READY: "draft_review_ready",
  DRAFT_REVIEW_POSTED: "draft_review_posted",
  WAITING_FOR_USER_SUBMIT: "waiting_for_user_submit",
  SUBMITTED_REVIEW: "submitted_review",
  RE_REVIEW_NEEDED: "re_review_needed",
  WAITING_FOR_AUTHOR_FOLLOWUP: "waiting_for_author_followup",
  WAITING_FOR_RE_REQUEST: "waiting_for_re_request",
  REVIEW_INVALIDATED: "review_invalidated",
  BLOCKED_NEEDS_USER_DECISION: "blocked_needs_user_decision",
});

// The reviewSubmissionStatus guard applies only after the {!prExists, prMerged, prClosed,
// prDraft} pre-gates, then fires ahead of the state-specific branches: failed ->
// blocked_needs_user_decision, submitted -> submitted_review. The table declares every such pair.
export const REVIEWER_TRANSITIONS = Object.freeze({
  [REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST]: [
    REVIEWER_STATE.REVIEW_REQUESTED,
    REVIEWER_STATE.SUBMITTED_REVIEW,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.REVIEW_REQUESTED]: [
    REVIEWER_STATE.DETERMINE_REVIEW_PLAN,
    REVIEWER_STATE.SUBMITTED_REVIEW,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.DETERMINE_REVIEW_PLAN]: [
    REVIEWER_STATE.REVIEWS_RUNNING,
    REVIEWER_STATE.SUBMITTED_REVIEW,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.REVIEWS_RUNNING]: [
    REVIEWER_STATE.MERGE_RESULTS,
    REVIEWER_STATE.SUBMITTED_REVIEW,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.MERGE_RESULTS]: [
    REVIEWER_STATE.DRAFT_REVIEW_READY,
    REVIEWER_STATE.SUBMITTED_REVIEW,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.DRAFT_REVIEW_READY]: [
    REVIEWER_STATE.DRAFT_REVIEW_POSTED,
    REVIEWER_STATE.SUBMITTED_REVIEW,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.DRAFT_REVIEW_POSTED]: [
    REVIEWER_STATE.WAITING_FOR_USER_SUBMIT,
    REVIEWER_STATE.REVIEW_INVALIDATED,
    REVIEWER_STATE.SUBMITTED_REVIEW,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.WAITING_FOR_USER_SUBMIT]: [
    REVIEWER_STATE.SUBMITTED_REVIEW,
    REVIEWER_STATE.REVIEW_INVALIDATED,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.RE_REVIEW_NEEDED]: [
    REVIEWER_STATE.REVIEW_REQUESTED,
    REVIEWER_STATE.SUBMITTED_REVIEW,
    REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.SUBMITTED_REVIEW]: [
    REVIEWER_STATE.RE_REVIEW_NEEDED,
    REVIEWER_STATE.REVIEW_REQUESTED,
    REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.WAITING_FOR_AUTHOR_FOLLOWUP]: [
    REVIEWER_STATE.SUBMITTED_REVIEW,
    REVIEWER_STATE.REVIEW_REQUESTED,
    REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST,
  ],
  [REVIEWER_STATE.WAITING_FOR_RE_REQUEST]: [
    REVIEWER_STATE.REVIEW_REQUESTED,
    REVIEWER_STATE.SUBMITTED_REVIEW,
  ],
  [REVIEWER_STATE.REVIEW_INVALIDATED]: [
    REVIEWER_STATE.REVIEW_REQUESTED,
    REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION]: [],
});

const REVIEWER_NEXT_ACTIONS = Object.freeze({
  [REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST]: "Wait for an explicit review request on the PR",
  [REVIEWER_STATE.REVIEW_REQUESTED]: "Capture PR context and start deterministic reviewer planning",
  [REVIEWER_STATE.DETERMINE_REVIEW_PLAN]: "Select a bounded review-angle plan and prepare local runs",
  [REVIEWER_STATE.REVIEWS_RUNNING]: "Wait for all bounded local review runs to complete",
  [REVIEWER_STATE.MERGE_RESULTS]: "Merge completed review results into one coherent review package",
  [REVIEWER_STATE.DRAFT_REVIEW_READY]: "Create a pending GitHub draft review from merged findings",
  [REVIEWER_STATE.DRAFT_REVIEW_POSTED]: "Share the draft review URL and move to submit wait state",
  [REVIEWER_STATE.WAITING_FOR_USER_SUBMIT]: "Wait for review submission through Pi or directly on GitHub",
  [REVIEWER_STATE.SUBMITTED_REVIEW]: "Review outcome submitted; hand off to remediation/fix follow-up until explicit re-request",
  [REVIEWER_STATE.RE_REVIEW_NEEDED]: "Submitted review predates the current head; request a fresh review on the current head",
  [REVIEWER_STATE.WAITING_FOR_AUTHOR_FOLLOWUP]: "Legacy external wait: author/Copilot follow-up boundary after submitted review",
  [REVIEWER_STATE.WAITING_FOR_RE_REQUEST]: "Legacy external wait: explicit re-request boundary after submitted review",
  [REVIEWER_STATE.REVIEW_INVALIDATED]: "Discard stale pending draft review and restart at review_requested",
  [REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION]: "Stop and request explicit user direction",
});

const VALID_LOCAL_PLANNING_STATUSES = new Set(["none", "determining", "complete", "failed"]);
const VALID_LOCAL_RUN_STATUSES = new Set(["none", "running", "completed", "failed"]);
const VALID_LOCAL_MERGE_STATUSES = new Set(["none", "ready", "failed"]);
const VALID_DRAFT_NOTIFICATION_STATUSES = new Set(["none", "notified"]);
const VALID_SUBMISSION_STATUSES = new Set(["none", "submitted", "failed"]);

function normalizePositiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function normalizeStatus(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function normalizeReviewerLogin(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}

function normalizeSubmittedReviewState(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return SUBMITTED_REVIEW_STATES.has(normalized) ? normalized : null;
}

/**
 * Normalize reviewer-loop snapshot data into a canonical, deterministic shape.
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeReviewerSnapshot(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Snapshot must be a non-null object");
  }

  const prExists = Boolean(raw.prExists);
  const reviewerLogin = normalizeReviewerLogin(raw.reviewerLogin);
  const reviewerScope = reviewerLogin !== null ? "single_reviewer" : "all_reviewers";

  return {
    prExists,
    prNumber: prExists ? normalizePositiveInt(raw.prNumber) : null,
    prDraft: Boolean(raw.prDraft),
    prMerged: Boolean(raw.prMerged),
    prClosed: Boolean(raw.prClosed),
    prHeadSha: prExists ? trimmedOrNull(raw.prHeadSha) : null,

    reviewerScope,
    reviewerLogin: reviewerScope === "single_reviewer" ? reviewerLogin : null,
    reviewRequested: Boolean(raw.reviewRequested),

    localPlanningStatus: normalizeStatus(raw.localPlanningStatus, VALID_LOCAL_PLANNING_STATUSES, "none"),
    localReviewRunsStatus: normalizeStatus(raw.localReviewRunsStatus, VALID_LOCAL_RUN_STATUSES, "none"),
    localMergeStatus: normalizeStatus(raw.localMergeStatus, VALID_LOCAL_MERGE_STATUSES, "none"),
    draftReviewPrepared: Boolean(raw.draftReviewPrepared),

    draftReviewPosted: Boolean(raw.draftReviewPosted),
    draftReviewId: normalizePositiveInt(raw.draftReviewId),
    draftReviewUrl: trimmedOrNull(raw.draftReviewUrl),
    draftReviewCommitSha: trimmedOrNull(raw.draftReviewCommitSha),
    draftReviewNotificationStatus: normalizeStatus(
      raw.draftReviewNotificationStatus,
      VALID_DRAFT_NOTIFICATION_STATUSES,
      "none",
    ),

    submittedReviewPresent: Boolean(raw.submittedReviewPresent),
    submittedReviewCommitSha: trimmedOrNull(raw.submittedReviewCommitSha),
    submittedReviewState: normalizeSubmittedReviewState(raw.submittedReviewState),
    reviewSubmissionStatus: normalizeStatus(raw.reviewSubmissionStatus, VALID_SUBMISSION_STATUSES, "none"),
  };
}

/**
 * Deterministically interpret current reviewer-loop state from a snapshot.
 *
 * @param {object} snapshot
 * @returns {{state: string, allowedTransitions: string[], nextAction: string}}
 */
export function interpretReviewerLoopState(snapshot) {
  const s = normalizeReviewerSnapshot(snapshot);

  const draftIsStale = s.draftReviewPosted
    && s.prHeadSha !== null
    && s.draftReviewCommitSha !== null
    && s.prHeadSha !== s.draftReviewCommitSha;

  const authorPushedSinceSubmit = s.submittedReviewPresent
    && s.prHeadSha !== null
    && s.submittedReviewCommitSha !== null
    && s.prHeadSha !== s.submittedReviewCommitSha;

  let state;

  if (!s.prExists || s.prMerged || s.prClosed) {
    state = REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST;
  } else if (s.prDraft) {
    state = REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST;
  } else if (s.reviewSubmissionStatus === "failed"
      || s.localPlanningStatus === "failed"
      || s.localReviewRunsStatus === "failed"
      || s.localMergeStatus === "failed") {
    state = REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION;
  } else if (draftIsStale) {
    state = REVIEWER_STATE.REVIEW_INVALIDATED;
  } else if (s.draftReviewPosted) {
    if (s.draftReviewNotificationStatus === "notified") {
      state = REVIEWER_STATE.WAITING_FOR_USER_SUBMIT;
    } else {
      state = REVIEWER_STATE.DRAFT_REVIEW_POSTED;
    }
  } else if (s.submittedReviewPresent) {
    if (!authorPushedSinceSubmit) state = REVIEWER_STATE.SUBMITTED_REVIEW;
    else if (s.reviewRequested) state = REVIEWER_STATE.REVIEW_REQUESTED;
    else state = REVIEWER_STATE.RE_REVIEW_NEEDED;
  } else if (s.reviewSubmissionStatus === "submitted") {
    state = REVIEWER_STATE.SUBMITTED_REVIEW;
  } else if (s.draftReviewPrepared || s.localMergeStatus === "ready") {
    state = REVIEWER_STATE.DRAFT_REVIEW_READY;
  } else if (s.localReviewRunsStatus === "completed") {
    state = REVIEWER_STATE.MERGE_RESULTS;
  } else if (s.localReviewRunsStatus === "running") {
    state = REVIEWER_STATE.REVIEWS_RUNNING;
  } else if (s.localPlanningStatus === "determining") {
    state = REVIEWER_STATE.DETERMINE_REVIEW_PLAN;
  } else if (s.reviewRequested) {
    state = REVIEWER_STATE.REVIEW_REQUESTED;
  } else {
    state = REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST;
  }

  return {
    state,
    allowedTransitions: [...REVIEWER_TRANSITIONS[state]],
    nextAction: REVIEWER_NEXT_ACTIONS[state],
  };
}

/**
 * Normalize free-form severity text to the bounded set:
 * critical | high | medium | low | note.
 * Unknown values are conservatively treated as medium.
 *
 * @param {unknown} value
 * @returns {"critical"|"high"|"medium"|"low"|"note"}
 */
function normalizeFindingSeverity(value) {
  // Unknown severities are treated as medium so merge synthesis stays conservative.
  // Valid severities: critical, high, medium, low, note.
  // (non-empty findings remain reviewable and can still produce COMMENT/REQUEST_CHANGES).
  const severity = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["critical", "high", "medium", "low", "note"].includes(severity)) {
    return severity;
  }
  return "medium";
}

export function buildDraftReviewPayload(mergedResult = {}) {
  const headSha = trimmedOrNull(mergedResult.headSha);
  const verdict = normalizeDraftVerdict(mergedResult.verdict);
  const inlineComments = Array.isArray(mergedResult.inlineComments) ? mergedResult.inlineComments : [];
  const summaryFindings = Array.isArray(mergedResult.summaryFindings) ? mergedResult.summaryFindings : [];

  const comments = inlineComments
    .filter((finding) => finding && typeof finding === "object")
    .map((finding) => ({
      path: trimmedOrNull(finding.path),
      line: typeof finding.line === "number" && finding.line > 0 ? Math.floor(finding.line) : null,
      body: typeof finding.message === "string" ? finding.message.trim() : "",
      side: "RIGHT",
    }))
    .filter((comment) => comment.path && comment.line && comment.body.length > 0);

  return {
    commit_id: headSha,
    body: buildDraftReviewBody({
      verdict,
      summaryFindings,
      totalFindings: typeof mergedResult.totalFindings === "number"
        ? Math.max(0, Math.floor(mergedResult.totalFindings))
        : comments.length + summaryFindings.length,
      runsMerged: typeof mergedResult.runsMerged === "number"
        ? Math.max(0, Math.floor(mergedResult.runsMerged))
        : 0,
    }),
    comments,
  };
}

function normalizeDraftVerdict(value) {
  return ["APPROVE", "COMMENT", "REQUEST_CHANGES"].includes(value) ? value : "COMMENT";
}

function buildDraftReviewBody({ verdict, summaryFindings, totalFindings, runsMerged }) {
  const lines = [
    `Reviewer-loop draft verdict: ${verdict}`,
    `Total findings: ${totalFindings}`,
    `Review runs merged: ${runsMerged}`,
  ];

  if (summaryFindings.length > 0) {
    lines.push("", "Summary findings:");
    for (const finding of summaryFindings) {
      const message = typeof finding?.message === "string" && finding.message.trim().length > 0
        ? finding.message.trim()
        : "Review finding";
      const severity = normalizeFindingSeverity(finding?.severity);
      lines.push(`- [${severity}] ${message}`);
    }
  } else if (totalFindings === 0) {
    lines.push("", "No summary-only findings were produced by the deterministic reviewer loop.");
  }

  return `${lines.join("\n")}\n`;
}
