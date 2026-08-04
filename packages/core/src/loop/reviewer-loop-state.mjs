/**
 * Deterministic state machine and bounded planning/merge contracts for reviewer-side PR loops.
 */
import { SUBMITTED_REVIEW_STATES } from "../github/copilot-helpers.mjs";

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
  [REVIEWER_STATE.SUBMITTED_REVIEW]: [
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
// The canonical whitelist lives in copilot-helpers; alias kept to avoid call-site churn.
const VALID_SUBMITTED_REVIEW_STATES = SUBMITTED_REVIEW_STATES;

const SUPPORTED_REVIEW_ANGLES = Object.freeze([
  "correctness",
  "tests",
  "maintainability",
  "security",
  "scope",
]);
const DEFAULT_REVIEW_MAX_PARALLEL = 3;
const HARD_REVIEW_MAX_PARALLEL = 4;

function normalizeSha(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

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
  return VALID_SUBMITTED_REVIEW_STATES.has(normalized) ? normalized : null;
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
    prHeadSha: prExists ? normalizeSha(raw.prHeadSha) : null,

    reviewerScope,
    reviewerLogin: reviewerScope === "single_reviewer" ? reviewerLogin : null,
    reviewRequested: Boolean(raw.reviewRequested),

    localPlanningStatus: normalizeStatus(raw.localPlanningStatus, VALID_LOCAL_PLANNING_STATUSES, "none"),
    localReviewRunsStatus: normalizeStatus(raw.localReviewRunsStatus, VALID_LOCAL_RUN_STATUSES, "none"),
    localMergeStatus: normalizeStatus(raw.localMergeStatus, VALID_LOCAL_MERGE_STATUSES, "none"),
    draftReviewPrepared: Boolean(raw.draftReviewPrepared),

    draftReviewPosted: Boolean(raw.draftReviewPosted),
    draftReviewId: normalizePositiveInt(raw.draftReviewId),
    draftReviewUrl: typeof raw.draftReviewUrl === "string" && raw.draftReviewUrl.trim().length > 0
      ? raw.draftReviewUrl.trim()
      : null,
    draftReviewCommitSha: normalizeSha(raw.draftReviewCommitSha),
    draftReviewNotificationStatus: normalizeStatus(
      raw.draftReviewNotificationStatus,
      VALID_DRAFT_NOTIFICATION_STATUSES,
      "none",
    ),

    submittedReviewPresent: Boolean(raw.submittedReviewPresent),
    submittedReviewCommitSha: normalizeSha(raw.submittedReviewCommitSha),
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
    state = authorPushedSinceSubmit && s.reviewRequested
      ? REVIEWER_STATE.REVIEW_REQUESTED
      : REVIEWER_STATE.SUBMITTED_REVIEW;
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
 * Build a bounded deterministic review-angle plan for parallel local runs.
 *
 * @param {{ requestedAngles?: string[], maxParallel?: number }} [options]
 * @returns {{ maxParallel: number, angles: string[], runs: {runId:string, angle:string}[] }}
 */
export function selectReviewerPlan(options = {}) {
  const requestedAngles = Array.isArray(options.requestedAngles)
    ? options.requestedAngles
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => SUPPORTED_REVIEW_ANGLES.includes(entry))
    : [];

  const maxParallel = typeof options.maxParallel === "number"
    && Number.isFinite(options.maxParallel)
    && options.maxParallel > 0
    ? Math.min(HARD_REVIEW_MAX_PARALLEL, Math.floor(options.maxParallel))
    : DEFAULT_REVIEW_MAX_PARALLEL;

  const chosenAngles = [];
  const source = requestedAngles.length > 0 ? requestedAngles : SUPPORTED_REVIEW_ANGLES;

  for (const angle of source) {
    if (!chosenAngles.includes(angle)) {
      chosenAngles.push(angle);
    }
    if (chosenAngles.length >= maxParallel) {
      break;
    }
  }

  return {
    maxParallel,
    angles: chosenAngles,
    runs: chosenAngles.map((angle, index) => ({
      runId: `review-angle-${String(index + 1).padStart(2, "0")}`,
      angle,
    })),
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

/**
 * Build a deterministic dedup key from finding location and message.
 *
 * @param {object} finding
 * @returns {string}
 */
function findingDedupKey(finding) {
  const pathPart = typeof finding.path === "string" ? finding.path.trim() : "";
  const linePart = typeof finding.line === "number" && finding.line > 0 ? String(Math.floor(finding.line)) : "";
  const messagePart = typeof finding.message === "string" ? finding.message.trim().toLowerCase() : "";
  return `${pathPart}|${linePart}|${messagePart}`;
}

/**
 * Deterministically merge bounded parallel review-run outputs into one review package.
 *
 * @param {{headSha?: string|null, runResults?: Array<{runId?:string, angle?:string, findings?:Array<object>, verdictHint?:string}>}} input
 * @returns {{headSha:string|null, verdict:string, inlineComments:object[], summaryFindings:object[], totalFindings:number, runsMerged:number}}
 */
export function mergeReviewerResults(input = {}) {
  const headSha = normalizeSha(input.headSha);
  const runResults = Array.isArray(input.runResults) ? input.runResults : [];

  const deduped = [];
  const seen = new Set();
  let hintRequestsChanges = false;

  for (const run of runResults) {
    if (run?.verdictHint === "REQUEST_CHANGES") {
      hintRequestsChanges = true;
    }
    const findings = Array.isArray(run?.findings) ? run.findings : [];

    for (const finding of findings) {
      const key = findingDedupKey(finding);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push({
        path: typeof finding.path === "string" ? finding.path.trim() : null,
        line: typeof finding.line === "number" && finding.line > 0 ? Math.floor(finding.line) : null,
        message: typeof finding.message === "string" ? finding.message.trim() : "",
        severity: normalizeFindingSeverity(finding.severity),
        angle: typeof run?.angle === "string" ? run.angle : null,
      });
    }
  }

  const inlineComments = deduped.filter((finding) => finding.path && finding.line && finding.message.length > 0);
  const summaryFindings = deduped.filter((finding) => !finding.path || !finding.line);

  const verdict = determineReviewVerdict(deduped, hintRequestsChanges);

  return {
    headSha,
    verdict,
    inlineComments,
    summaryFindings,
    totalFindings: deduped.length,
    runsMerged: runResults.length,
  };
}

export function buildDraftReviewPayload(mergedResult = {}) {
  const headSha = normalizeSha(mergedResult.headSha);
  const verdict = normalizeDraftVerdict(mergedResult.verdict);
  const inlineComments = Array.isArray(mergedResult.inlineComments) ? mergedResult.inlineComments : [];
  const summaryFindings = Array.isArray(mergedResult.summaryFindings) ? mergedResult.summaryFindings : [];

  const comments = inlineComments
    .filter((finding) => finding && typeof finding === "object")
    .map((finding) => ({
      path: typeof finding.path === "string" && finding.path.trim().length > 0 ? finding.path.trim() : null,
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

export const REVIEWER_SUPPORTED_ANGLES = Object.freeze([...SUPPORTED_REVIEW_ANGLES]);

/**
 * Determine one merged review verdict from deduplicated findings.
 * - APPROVE when there are no findings
 * - REQUEST_CHANGES when a run explicitly hints it, or high/critical severity exists
 * - COMMENT otherwise
 *
 * @param {Array<{severity:string}>} dedupedFindings
 * @param {boolean} hintRequestsChanges
 * @returns {"APPROVE"|"REQUEST_CHANGES"|"COMMENT"}
 */
function determineReviewVerdict(dedupedFindings, hintRequestsChanges) {
  if (dedupedFindings.length === 0) {
    return "APPROVE";
  }

  const hasBlockingSeverity = dedupedFindings
    .some((finding) => finding.severity === "critical" || finding.severity === "high");

  if (hintRequestsChanges || hasBlockingSeverity) {
    return "REQUEST_CHANGES";
  }

  return "COMMENT";
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
