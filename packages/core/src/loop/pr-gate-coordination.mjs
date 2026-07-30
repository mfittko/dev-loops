import { DISPOSITION, isCopilotRoundCapReached, STATE } from "./copilot-loop-state.mjs";
import { findBlockingTitleMarkers } from "./pr-title-markers.mjs";
import { evaluateUiE2eScoping } from "./ui-e2e-scoping.mjs";

export const PR_CHECKPOINT = Object.freeze({
  DRAFT_REVIEW: "draft_review",
  POST_DRAFT_EXTERNAL_REVIEW: "post_draft_external_review",
  FEEDBACK_RESOLUTION: "feedback_resolution",
  CONFLICT_RESOLUTION: "conflict_resolution",
  UI_E2E_SCOPING: "ui_e2e_scoping",
  PRE_APPROVAL_GATE_WINDOW: "pre_approval_gate_window",
  FINAL_APPROVAL_READY: "final_approval_ready",
  PRE_APPROVAL_GATE_NEEDED: "pre_approval_gate_needed",
  DRAFT_GATE_NEEDED: "draft_gate_needed",
  BLOCKED: "blocked",
  DONE: "done",
});


/**
 * Refinement-artifact gate check (issue #532).
 *
 * The draft gate must verify the linked issue has an explicit refinement
 * artifact (Acceptance criteria / DoD / linked refinement doc) before it
 * can post a clean verdict. When the artifact is missing the draft gate
 * must post verdict=blocked with the missing_refinement_artifact finding
 * and the PR cannot leave draft.
 */
export const REFINEMENT_ARTIFACT_STATUS = Object.freeze({
  MISSING: "missing",
  PRESENT: "present",
  UNKNOWN: "unknown",
});

export const REFINEMENT_ARTIFACT_FINDING = "missing_refinement_artifact";

/**
 * `refinementArtifact.specSource` values: which of the three sanctioned
 * spec-of-record origins (artifact-authority-contract.md) backed the check.
 */
export const REFINEMENT_ARTIFACT_SPEC_SOURCE = Object.freeze({
  LINKED_ISSUE: "linked_issue",
  PR_BODY: "pr_body",
  PLAN_FILE: "plan_file",
});

export const PR_CHECKPOINT_ACTION = Object.freeze({
  RUN_DRAFT_GATE: "run_draft_gate",
  MARK_READY_FOR_REVIEW: "mark_ready_for_review",
  REQUEST_COPILOT_REVIEW: "request_copilot_review",
  WAIT_FOR_COPILOT_REVIEW: "wait_for_copilot_review",
  WAIT_FOR_CI: "wait_for_ci",
  ADDRESS_REVIEW_FEEDBACK: "address_review_feedback",
  REPLY_RESOLVE_REVIEW_THREADS: "reply_resolve_review_threads",
  REREQUEST_COPILOT_REVIEW: "rerequest_copilot_review",
  RESOLVE_MERGE_CONFLICTS: "resolve_merge_conflicts",
  RUN_PRE_APPROVAL_GATE: "run_pre_approval_gate",
  AWAIT_FINAL_HUMAN_APPROVAL: "await_final_human_approval",
  DECLARE_MERGE_READY: "declare_merge_ready",
  RECONCILE_DRAFT_GATE: "reconcile_draft_gate",
  REPORT_BLOCKED: "report_blocked",
  REPORT_DONE: "report_done",
  RUN_UI_E2E_SUITE: "run_ui_e2e_suite",
});

function normalizeGateComment(summary = null) {
  if (!summary || typeof summary !== "object") {
    return {
      visible: false,
      headSha: null,
      verdict: null,
      findingsSummary: null,
      nextAction: null,
      contractComplete: false,
    };
  }

  return {
    visible: summary.visible === true,
    headSha: typeof summary.headSha === "string" && summary.headSha.trim().length > 0 ? summary.headSha.trim() : null,
    verdict: typeof summary.verdict === "string" && summary.verdict.trim().length > 0 ? summary.verdict.trim().toLowerCase() : null,
    findingsSummary: typeof summary.findingsSummary === "string" && summary.findingsSummary.trim().length > 0
      ? summary.findingsSummary.trim()
      : null,
    nextAction: typeof summary.nextAction === "string" && summary.nextAction.trim().length > 0
      ? summary.nextAction.trim()
      : null,
    contractComplete: summary.contractComplete === true,
  };
}

function toGateStatus(comment, marker, currentHeadSha) {
  const normalizedComment = normalizeGateComment(comment);
  const normalizedMarker = normalizeGateComment(marker);
  const markerHeadMatches = normalizedMarker.headSha !== null
    && typeof currentHeadSha === "string"
    && currentHeadSha.startsWith(normalizedMarker.headSha);
  const anyVisible = normalizedComment.visible || normalizedMarker.visible;

  const cleanEvidenceExists = normalizedComment.visible && normalizedComment.verdict === "clean" && normalizedComment.headSha !== null;

  return {
    visible: normalizedComment.visible,
    markerVisible: normalizedMarker.visible,
    anyVisible,
    currentHead: normalizedMarker.visible && markerHeadMatches,
    headSha: normalizedComment.headSha ?? normalizedMarker.headSha,
    verdict: normalizedComment.verdict ?? normalizedMarker.verdict,
    findingsSummary: normalizedComment.findingsSummary ?? normalizedMarker.findingsSummary,
    nextAction: normalizedComment.nextAction ?? normalizedMarker.nextAction,
    contractComplete: normalizedMarker.visible && markerHeadMatches && normalizedMarker.contractComplete,
    currentHeadClean: normalizedMarker.visible && markerHeadMatches && normalizedMarker.verdict === "clean" && normalizedMarker.contractComplete,
    cleanEvidenceExists,
  };
}

function pushUnique(values, additions) {
  for (const value of additions) {
    if (typeof value === "string" && value.length > 0 && !values.includes(value)) {
      values.push(value);
    }
  }
}

const BLOCKED_MERGE_STATE_STATUSES = new Set(["DIRTY", "CONFLICTING", "BEHIND"]);

function normalizeMergeStateStatus(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  return value.trim().toUpperCase();
}

function normalizeMergeable(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const upper = value.trim().toUpperCase();
  if (upper === "MERGEABLE" || upper === "CONFLICTING" || upper === "UNKNOWN") {
    return upper;
  }

  return null;
}

function normalizeConflictFiles(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    if (entry.trim().length > 0 && !normalized.includes(entry)) {
      normalized.push(entry);
    }
  }

  return normalized;
}

function hasBlockedMergeStatus(mergeStateStatus) {
  return mergeStateStatus !== null && BLOCKED_MERGE_STATE_STATUSES.has(mergeStateStatus);
}

function formatBlockedMergeReason(mergeStateStatus, conflictFiles, mergeable = null) {
  if (mergeStateStatus === "BEHIND") {
    let reason = "Branch must be updated from base before entering any gate.";
    reason += ` GitHub mergeStateStatus: ${mergeStateStatus}.`;
    return reason;
  }

  let reason = "The current branch conflicts with the base branch, so resolve the conflict locally on the PR branch (run `node scripts/loop/resolve-pr-conflicts.mjs --push` for the safe additive-CHANGELOG case), rerun validation, rerun gate detection, and only then resume the normal gate path.";

  if (mergeable === "CONFLICTING") {
    reason += " GitHub mergeable: CONFLICTING.";
  }

  if (mergeStateStatus !== null) {
    reason += ` GitHub mergeStateStatus: ${mergeStateStatus}.`;
  }

  if (conflictFiles.length > 0) {
    reason += ` Conflicting files: ${conflictFiles.join(", ")}.`;
  }

  return reason;
}

function normalizeCiStatus(value) {
  if (typeof value !== "string") {
    return "none";
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "none";
  }

  const lower = trimmed.toLowerCase();
  if (lower === "success" || lower === "failure" || lower === "pending" || lower === "none") {
    return lower;
  }

  if (lower === "crediblygreen") {
    return "crediblyGreen";
  }

  return "none";
}

function normalizeNonNegativeInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
}

function normalizePositiveInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.floor(value);
}

function normalizeRefinementArtifactStatus(value) {
  if (value === REFINEMENT_ARTIFACT_STATUS.MISSING || value === REFINEMENT_ARTIFACT_STATUS.PRESENT) {
    return value;
  }
  return REFINEMENT_ARTIFACT_STATUS.UNKNOWN;
}

// Issue-less refinement artifacts (specSource "pr_body"/"plan_file") carry
// their own validation-failure reason from the detector; that reason must
// replace the "linked issue" wording, which does not apply when the PR is the
// spec-of-record and no linked issue was ever expected.
function formatRefinementBlockedReason(linkedIssue, status, refinementArtifact) {
  const specSource = refinementArtifact?.specSource;
  if (specSource != null && specSource !== REFINEMENT_ARTIFACT_SPEC_SOURCE.LINKED_ISSUE && typeof refinementArtifact?.reason === "string" && refinementArtifact.reason.length > 0) {
    return `The draft gate cannot complete: ${refinementArtifact.reason} finding=${REFINEMENT_ARTIFACT_FINDING}`;
  }
  if (linkedIssue !== null && Number.isInteger(linkedIssue)) {
    return `Linked issue #${linkedIssue} has no refinement artifact (Acceptance criteria / DoD / linked refinement doc). Run refinement first, add ACs/DoD to the issue, then re-open the draft PR. finding=${REFINEMENT_ARTIFACT_FINDING}`;
  }
  return `The draft gate cannot complete: the linked issue has no detectable refinement artifact (Acceptance criteria / DoD / linked refinement doc). finding=${REFINEMENT_ARTIFACT_FINDING}`;
}

function buildRoundExhaustionGateEvidenceNote({ copilotReviewRoundCount, maxCopilotRounds, ciStatus, preApprovalRequireCi }) {
  // #1472 defer: when CI is not required by config, the grant does not rest on
  // any CI verdict at all — do not claim "green or credibly green CI" for a
  // head whose CI may be failing/pending/none. Callers that omit ciStatus /
  // preApprovalRequireCi keep the original CI-confirmed wording unchanged.
  const ciDescriptor = preApprovalRequireCi === false && ciStatus !== "success"
    ? "CI not required by config"
    : "green or credibly green CI";
  return `Copilot review rounds exhausted (${copilotReviewRoundCount}/${maxCopilotRounds}); current head has zero unresolved threads and ${ciDescriptor}, so pre_approval_gate fallback is allowed without another Copilot re-request.`;
}

/**
 * Blocked result for a PR that would otherwise reach final_approval_ready but
 * still carries a merge-blocking marker in its title (issue #842). The title is
 * the most visible contract surface, so a WIP/DRAFT/DO NOT MERGE title must
 * block the final-approval boundary just like the mark-ready transition does.
 */
function buildTitleMarkerBlockedResult({
  input,
  currentHeadSha,
  draftGateAlreadySatisfied,
  draftGate,
  preApprovalGate,
  mergeStateStatus,
  conflictFiles,
  markers,
  refinementArtifact = null,
}) {
  const allowedNextActions = [];
  const forbiddenActions = [];
  pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]);
  pushUnique(forbiddenActions, [
    PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
    PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
    PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
    PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
    PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
    PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
  ]);

  return buildResult({
    repo: input.repo ?? null,
    pr: Number.isInteger(input.pr) ? input.pr : null,
    currentHeadSha,
    lifecycleState: "title_marker_blocked",
    loopDisposition: DISPOSITION.BLOCKED,
    gateBoundary: PR_CHECKPOINT.BLOCKED,
    draftGateAlreadySatisfied,
    draftGate,
    preApprovalGate,
    allowedNextActions,
    forbiddenActions,
    nextAction: PR_CHECKPOINT_ACTION.REPORT_BLOCKED,
    reason: `Blocked: the PR title contains merge-blocking marker(s): ${markers.join(", ")}. Remove them from the title before the PR can leave draft, enter the pre-approval gate, or reach final approval.`,
    mergeStateStatus,
    conflictFiles,
      refinementArtifact,
  });
}


function buildDraftGateNeededForMergeResult({
  input,
  currentHeadSha,
  draftGate,
  preApprovalGate,
  mergeStateStatus,
  conflictFiles,
  underlyingReason = null,
  refinementArtifact = null,
  effectiveLifecycleState = null,
}) {
  const allowedNextActions = [];
  const forbiddenActions = [];
  pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE]);
  pushUnique(forbiddenActions, [
    PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
    PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
    PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
    PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
    PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
    PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
  ]);

  return buildResult({
    repo: input.repo ?? null,
    pr: Number.isInteger(input.pr) ? input.pr : null,
    currentHeadSha,
    lifecycleState: effectiveLifecycleState ?? STATE.BLOCKED_NEEDS_USER_DECISION,
    loopDisposition: DISPOSITION.ACTION_REQUIRED,
    gateBoundary: PR_CHECKPOINT.DRAFT_GATE_NEEDED,
    draftGateAlreadySatisfied: false,
    draftGate,
    preApprovalGate,
    allowedNextActions,
    forbiddenActions,
    nextAction: PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE,
    reason: `Clean draft_gate evidence is required before merge (no gate exemptions, #579).${draftGate?.anyVisible ? " A draft_gate comment exists but is not clean; convert the PR back to draft before re-running draft_gate, or clear the existing evidence before running reconcile_draft_gate." : " No visible clean draft_gate comment exists for this PR; run reconcile_draft_gate before proceeding."}${underlyingReason ? ` ${underlyingReason}` : ""}`,
    mergeStateStatus,
    conflictFiles,
    refinementArtifact,
  });
}
function buildResult({
  draftGateAlreadySatisfied = false,
  repo = null,
  pr = null,
  currentHeadSha = null,
  lifecycleState,
  loopDisposition,
  gateBoundary,
  draftGate,
  preApprovalGate,
  allowedNextActions,
  forbiddenActions,
  nextAction,
  reason,
  mergeStateStatus = null,
  conflictFiles = [],
  gateEvidenceNote = null,
  refinementArtifact = null,
  inputRefinementArtifact = null,
  copilotReviewRoundCount = null,
}) {
  const effectiveRefinementArtifact = refinementArtifact ?? inputRefinementArtifact ?? null;
  return {
    ok: true,
    ...(repo ? { repo } : {}),
    ...(pr !== null ? { pr } : {}),
    currentHeadSha,
    lifecycleState,
    loopDisposition,
    gateBoundary,
    draftGate,
    preApprovalGate,
    allowedNextActions,
    forbiddenActions,
    nextAction,
    reason,
    mergeStateStatus,
    conflictFiles,
    draftGateAlreadySatisfied,
    copilotReviewRoundCount,
    gateEvidenceRequiredForMerge: true,
    ...(gateEvidenceNote ? { gateEvidenceNote } : {}),
    ...(effectiveRefinementArtifact ? { refinementArtifact: effectiveRefinementArtifact } : {}),
  };
}


/**
 * Guard: detect when Copilot has reviewed the PR without a formal
 * review request and the gate boundary is pre_approval_gate territory.
 * Returns true when the pre-approval gate should be blocked and the
 * caller must run request-copilot-review.mjs first.
 *
 * Exception: round-cap clean fallback (rounds exhausted + clean converged)
 * does not require a formal re-request (#613).
 *
 * @param {object} params
 * @param {string} params.copilotReviewRequestStatus - "none"|"requested"|"already-requested"|"unavailable"|"failed"
 * @param {boolean} [params.copilotReviewEverFormallyRequested=false] - whether Copilot was ever formally requested via GitHub review_requested mechanism
 * @param {number} params.copilotReviewRoundCount
 * @param {number|null} params.maxCopilotRounds
 * @param {boolean} params.sameHeadCleanConverged
 * @param {boolean} [params.roundCapCleanFallback=false] - interpreter resolved the
 *   round-cap clean fallback (#896): rounds exhausted + clean threads + green CI on
 *   the current head, including a post-cap head Copilot has not (and will not)
 *   re-review. No further Copilot round is permitted, so the formal-request guard
 *   must not fire — the pre_approval_gate reviews the post-cap head (per #848).
 * @param {boolean} [params.postConvergenceSignificantChange=false] - significant
 *   post-convergence changes on a newer head start a new review cycle and must
 *   not be treated as round-cap clean-fallback suppression.
 * @param {string} params.gateBoundary - current gate boundary
 * @returns {boolean}
 */
export function shouldGuardCopilotReviewRequest({
  copilotReviewRequestStatus,
  copilotReviewRoundCount = 0,
  copilotReviewEverFormallyRequested = false,
  maxCopilotRounds = null,
  sameHeadCleanConverged = false,
  roundCapCleanFallback = false,
  postConvergenceSignificantChange = false,
  gateBoundary,
}) {
  const gateBoundariesRequiringCopilotFormalRequest = new Set([
    PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
    PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
    PR_CHECKPOINT.FINAL_APPROVAL_READY,
  ]);
  if (!gateBoundariesRequiringCopilotFormalRequest.has(gateBoundary)) {
    return false;
  }
  // Copilot review disabled for the repo (maxCopilotRounds: 0): never force a
  // formal request — the loop runs draft_gate → pre_approval with the local
  // harness only. See evaluatePrGateCoordination (internal_only routing).
  if (maxCopilotRounds === 0) {
    return false;
  }
  if (copilotReviewRequestStatus !== "none") {
    return false;
  }
  // Durable signal: if Copilot was ever formally requested as a reviewer,
  // the current "none" status is from a fulfilled request (normal cycle),
  // not from a missing request. Do not guard the happy path (#613, round 2).
  if (copilotReviewEverFormallyRequested) {
    return false;
  }
  // Round-cap clean fallback: exhausted rounds + clean converged does not require
  // a formal re-request. This covers two shapes of "clean at the cap":
  //  - sameHeadCleanConverged: the current head itself carries a clean Copilot review;
  //  - roundCapCleanFallback (#896): the head is clean (zero unresolved threads + green
  //    CI) but Copilot has NOT reviewed THIS head (e.g. a post-cap commit). No further
  //    Copilot round is permitted, so forcing a formal request would dead-end the loop;
  //    the pre_approval_gate reviews the post-cap head instead (per #848).
  const roundCapReached = isCopilotRoundCapReached({ copilotReviewRoundCount, maxCopilotRounds });
  if (
    roundCapReached
    && (sameHeadCleanConverged || roundCapCleanFallback)
    && !postConvergenceSignificantChange
  ) {
    return false;
  }
  return true;
}

/**
 * Boundaries at which a non-draft PR must NOT carry a merge-blocking title
 * marker (issue #842 / AC2). A WIP/DRAFT/DO NOT MERGE/🚧 title is acceptable
 * while the PR is still in draft, but the moment the PR leaves draft and reaches
 * the pre-approval gate boundary (entry) or the final-approval boundary, the
 * title is a live merge-contract surface and must be clean. The guard is applied
 * once, as a post-pass over the core evaluation result, so no individual return
 * site can be missed even if a PR was un-drafted externally (bypassing
 * ready-for-review).
 */
const TITLE_MARKER_GUARDED_BOUNDARIES = Object.freeze([
  PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
  PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  PR_CHECKPOINT.FINAL_APPROVAL_READY,
]);

/**
 * Independent gate-ENTRY re-check (issue #1190): even when the caller's
 * lifecycleState/sameHeadCleanConverged claims a settled Copilot convergence,
 * an outstanding (`requested`/`already-requested`) Copilot review request on
 * the CURRENT head is a second, independent "unsettled" signal — not derived
 * from sameHeadCleanConverged — that must refuse pre_approval_gate /
 * final-approval entry outright.
 *
 * This mirrors the fail-closed predicate that previously only fired at
 * *verdict-post* time (upsert-checkpoint-verdict.mjs, which refuses to post a
 * pre_approval_gate verdict while this same evaluator forbids
 * RUN_PRE_APPROVAL_GATE): asserting it here, at gate *entry*, refuses the
 * pre-approval fan-out up front instead of only after reviewer tokens have
 * already been spent.
 *
 * Skipped when Copilot review is not required at all — `reviewMode:
 * "internal_only"` or `maxCopilotRounds: 0` — preserving the existing #613 /
 * #1210 exemptions (internal-only and light-dispatched-with-disabled-review
 * PRs never need a Copilot round in the first place).
 */
const PRE_APPROVAL_ENTRY_BOUNDARIES = Object.freeze([
  PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
  PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
  PR_CHECKPOINT.FINAL_APPROVAL_READY,
]);

function applyUnsettledCopilotReviewEntryGuard(input, result) {
  if (!result || typeof result !== "object" || !PRE_APPROVAL_ENTRY_BOUNDARIES.includes(result.gateBoundary)) {
    return null;
  }
  if (input.maxCopilotRounds === 0) {
    return null;
  }
  const reviewMode = typeof input.reviewMode === "string" ? input.reviewMode.trim().toLowerCase() : null;
  if (reviewMode === "internal_only") {
    return null;
  }
  const copilotReviewRequestStatus = typeof input.copilotReviewRequestStatus === "string"
    ? input.copilotReviewRequestStatus.trim().toLowerCase()
    : "none";
  if (copilotReviewRequestStatus !== "requested" && copilotReviewRequestStatus !== "already-requested") {
    return null;
  }
  // Round-cap exemption (mirrors shouldGuardCopilotReviewRequest, #896/#848):
  // past the cap a lingering requested/already-requested status is for a review
  // that can never come (no further round is permitted), so treating it as
  // "unsettled" here would re-introduce the infinite-wait dead-end the
  // ROUND_CAP_CLEAN_FALLBACK routing exists to prevent. When the cap is reached
  // and the head is clean — either sameHeadCleanConverged or the interpreter's
  // round_cap_clean_fallback state — the pre_approval_gate proceeds unless
  // significant post-convergence changes require a new review cycle.
  const roundCapReached = isCopilotRoundCapReached({
    copilotReviewRoundCount: input.copilotReviewRoundCount,
    maxCopilotRounds: input.maxCopilotRounds,
  });
  const lifecycleState = typeof input.lifecycleState === "string" ? input.lifecycleState.trim().toLowerCase() : "";
  const roundCapCleanFallback = lifecycleState === STATE.ROUND_CAP_CLEAN_FALLBACK;
  if (
    roundCapReached
    && (input.sameHeadCleanConverged === true || roundCapCleanFallback)
    && input.postConvergenceSignificantChange !== true
  ) {
    return null;
  }

  const allowedNextActions = [];
  const forbiddenActions = [];
  pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW]);
  // Full postDraftForbidden set (matching the canonical WAITING_FOR_COPILOT_REVIEW
  // result this guard synthesizes) plus the final-approval actions the replaced
  // boundary result also forbade — dropping RUN_DRAFT_GATE/MARK_READY_FOR_REVIEW
  // here would let a draft_gate verdict post on a non-draft PR slip through where
  // the replaced result would have refused it.
  pushUnique(forbiddenActions, [
    PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
    PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
    PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
    PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
    PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
  ]);

  return buildResult({
    repo: input.repo ?? null,
    pr: Number.isInteger(input.pr) ? input.pr : null,
    currentHeadSha: result.currentHeadSha ?? null,
    lifecycleState: STATE.WAITING_FOR_COPILOT_REVIEW,
    loopDisposition: DISPOSITION.PENDING,
    gateBoundary: PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
    draftGateAlreadySatisfied: result.draftGateAlreadySatisfied === true,
    draftGate: result.draftGate,
    preApprovalGate: result.preApprovalGate,
    allowedNextActions,
    forbiddenActions,
    nextAction: PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW,
    reason: "A Copilot review request is still outstanding on the current head (independent gate-entry "
      + "re-check, issue #1190) — pre_approval_gate/final-approval entry is refused until the current-head "
      + "review settles, even though the caller-reported convergence signal claims otherwise.",
    mergeStateStatus: result.mergeStateStatus ?? null,
    conflictFiles: result.conflictFiles ?? [],
    refinementArtifact: result.refinementArtifact ?? null,
    copilotReviewRoundCount: normalizeNonNegativeInteger(input.copilotReviewRoundCount),
  });
}

/**
 * Evaluates PR gate coordination, then re-asserts the merge-blocking title guard
 * (issue #842) at the pre-approval / final-approval boundary for non-draft PRs.
 *
 * The title check is also performed inline at the three FINAL_APPROVAL_READY
 * sites (defense in depth); this wrapper additionally covers the pre-approval
 * gate boundary, which is reached before any pre-approval evidence exists and so
 * is not protected by the inline checks.
 */
export function evaluatePrGateCoordination(input = {}) {
  const result = evaluatePrGateCoordinationCore(input);

  const unsettledReviewResult = applyUnsettledCopilotReviewEntryGuard(input, result);
  if (unsettledReviewResult) {
    return unsettledReviewResult;
  }

  const prDraft = input.prDraft === true;
  const prTitle = typeof input.prTitle === "string" ? input.prTitle : "";
  // Draft PRs may legitimately carry a WIP title; the marker only blocks once
  // the PR has left draft and is at a pre-approval/final-approval boundary.
  if (prDraft || !result || typeof result !== "object") {
    return result;
  }
  if (!TITLE_MARKER_GUARDED_BOUNDARIES.includes(result.gateBoundary)) {
    return result;
  }
  const markers = findBlockingTitleMarkers(prTitle);
  if (markers.length === 0) {
    return result;
  }

  return buildTitleMarkerBlockedResult({
    input,
    currentHeadSha: result.currentHeadSha ?? null,
    draftGateAlreadySatisfied: result.draftGateAlreadySatisfied === true,
    draftGate: result.draftGate,
    preApprovalGate: result.preApprovalGate,
    mergeStateStatus: result.mergeStateStatus ?? null,
    conflictFiles: result.conflictFiles ?? [],
    markers,
    refinementArtifact: result.refinementArtifact ?? null,
  });
}

function evaluatePrGateCoordinationCore(input = {}) {
  const currentHeadSha = typeof input.currentHeadSha === "string" && input.currentHeadSha.trim().length > 0
    ? input.currentHeadSha.trim()
    : null;
  const lifecycleState = typeof input.lifecycleState === "string" ? input.lifecycleState.trim().toLowerCase() : "";
  const loopDisposition = typeof input.loopDisposition === "string" ? input.loopDisposition.trim().toLowerCase() : null;
  const prDraft = input.prDraft === true;
  const prClosed = input.prClosed === true;
  const prMerged = input.prMerged === true;
  const sameHeadCleanConverged = input.sameHeadCleanConverged === true;
  // maxCopilotRounds: 0 disables the external Copilot review gate entirely
  // (for repos without Copilot / local-harness-only review). It reuses the
  // existing internal_only routing — skip the Copilot cycle, go straight to
  // pre_approval — so no separate skip path is needed.
  const copilotReviewDisabled = input.maxCopilotRounds === 0;
  const reviewMode = copilotReviewDisabled
    ? "internal_only"
    : (typeof input.reviewMode === "string" ? input.reviewMode.trim().toLowerCase() : null);
  const mergeStateStatus = normalizeMergeStateStatus(input.mergeStateStatus);
  const mergeable = normalizeMergeable(input.mergeable);
  const conflictFiles = normalizeConflictFiles(input.conflictFiles);
  const ciStatus = normalizeCiStatus(input.ciStatus);
  const draftGateRequireCi = input.draftGateRequireCi !== false;
  // Opt-out CI precondition at the pre-approval boundary (mirrors the draft
  // gate). Default true keeps CI required; false ignores the CI verdict
  // entirely — a "none"/"pending"/"crediblyGreen"/"failure" head no longer
  // waits on or blocks pre_approval.
  const preApprovalRequireCi = input.preApprovalRequireCi !== false;
  const copilotReviewRoundCount = normalizeNonNegativeInteger(input.copilotReviewRoundCount);
  const maxCopilotRounds = normalizePositiveInteger(input.maxCopilotRounds);
  const roundCapReached = isCopilotRoundCapReached({ copilotReviewRoundCount, maxCopilotRounds });
  // #1472: explicit current-head unresolved-thread signal for the round-cap
  // fallback check below (STATE.ROUND_CAP_REACHED). Unlike copilotReviewRoundCount
  // (which safely defaults to 0 when absent), an absent/invalid count here must
  // NOT be coerced to 0 — that would silently treat an unknown thread count as
  // clean and wrongly unblock the fallback. `null` means "unknown" (fail closed).
  const unresolvedThreadCount = Number.isInteger(input.unresolvedThreadCount)
    && input.unresolvedThreadCount >= 0
    ? input.unresolvedThreadCount
    : null;
  const postConvergenceSignificantChange = input.postConvergenceSignificantChange === true;
  const roundCapNewCycleRequired = roundCapReached && copilotReviewRoundCount > 0 && postConvergenceSignificantChange;
  const prTitle = typeof input.prTitle === "string" ? input.prTitle : "";
  // UI e2e auto-scoping (#976): the PR changed-file set + whether the shared UI
  // e2e suite passed for this head. Inclusion is path-triggered, never annotated.
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : [];
  const uiE2ePassed = input.uiE2ePassed === true ? true : (input.uiE2ePassed === false ? false : null);
  const refinementArtifact = input.refinementArtifact && typeof input.refinementArtifact === "object"
    ? input.refinementArtifact
    : null;
  const refinementArtifactStatus = normalizeRefinementArtifactStatus(refinementArtifact?.status);
  const refinementLinkedIssue = Number.isInteger(refinementArtifact?.linkedIssue) ? refinementArtifact.linkedIssue : null;

  const effectiveLifecycleState = lifecycleState;

  const draftGate = toGateStatus(input.draftGate, input.draftGateMarker, currentHeadSha);
  const preApprovalGate = toGateStatus(input.preApprovalGate, input.preApprovalGateMarker, currentHeadSha);
  const draftGateAlreadySatisfied = !prDraft && (draftGate?.cleanEvidenceExists ?? false);

  const allowedNextActions = [];
  const forbiddenActions = [];

  if (prMerged || prClosed || effectiveLifecycleState === STATE.DONE) {
    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_DONE]);
    pushUnique(forbiddenActions, [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ]);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: loopDisposition ?? DISPOSITION.DONE,
      gateBoundary: PR_CHECKPOINT.DONE,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.REPORT_DONE,
      reason: "The pull request is already closed or merged, so no further gate entry is legal.",
      mergeStateStatus,
      conflictFiles,
        refinementArtifact,
    copilotReviewRoundCount,
    });
  }

  if (effectiveLifecycleState === STATE.BLOCKED_NEEDS_USER_DECISION || effectiveLifecycleState === STATE.REVIEW_REQUEST_UNAVAILABLE) {
    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]);
    pushUnique(forbiddenActions, [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ]);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: loopDisposition ?? DISPOSITION.BLOCKED,
      gateBoundary: PR_CHECKPOINT.BLOCKED,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.REPORT_BLOCKED,
      reason: "The PR is in a blocked lifecycle state, so gate progression must stop for a user decision.",
      mergeStateStatus,
      conflictFiles,
        refinementArtifact,
    copilotReviewRoundCount,
    });
  }

  // Mergeability is a required precondition at every gate (issue #980). GitHub
  // computes `mergeable` asynchronously, so an unsettled UNKNOWN must fail closed
  // to a recheck — never a pass. The detect layer already re-polls a bounded
  // number of times; if it still reads UNKNOWN here, hold gate progression and
  // recheck rather than guess.
  if (mergeable === "UNKNOWN") {
    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.WAIT_FOR_CI]);
    pushUnique(forbiddenActions, [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ]);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: DISPOSITION.PENDING,
      gateBoundary: PR_CHECKPOINT.CONFLICT_RESOLUTION,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.WAIT_FOR_CI,
      reason: "GitHub has not yet computed mergeability (mergeable=UNKNOWN), so gate progression is held: recheck before proceeding rather than treating an unsettled merge state as clean.",
      mergeStateStatus,
      conflictFiles,
      refinementArtifact,
      copilotReviewRoundCount,
    });
  }

  if (hasBlockedMergeStatus(mergeStateStatus) || mergeable === "CONFLICTING" || conflictFiles.length > 0) {
    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS]);
    pushUnique(forbiddenActions, [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.WAIT_FOR_CI,
      PR_CHECKPOINT_ACTION.ADDRESS_REVIEW_FEEDBACK,
      PR_CHECKPOINT_ACTION.REPLY_RESOLVE_REVIEW_THREADS,
      PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ]);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: DISPOSITION.ACTION_REQUIRED,
      gateBoundary: PR_CHECKPOINT.CONFLICT_RESOLUTION,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS,
      reason: formatBlockedMergeReason(mergeStateStatus, conflictFiles, mergeable),
      mergeStateStatus,
      conflictFiles,
        refinementArtifact,
    copilotReviewRoundCount,
    });
  }

  // UI e2e auto-scoping precondition (#976). Path-triggered + fail-closed:
  // if the PR's changed files touch a rendered artifact (a deck under
  // docs/articles|presentations, or the inspect-run viewer source), it MUST be
  // registered in the shared UI e2e suite AND that suite must have passed for
  // this head. A rendered-artifact change with no registered/passing coverage
  // blocks here with a reason naming the artifact. Distinct seam from the
  // mergeability (#980) preconditions to minimize
  // merge-time conflict. Non-UI changes pass through untouched (required=false).
  const uiE2eScoping = evaluateUiE2eScoping(changedFiles, { uiE2ePassed });
  if (uiE2eScoping.required && !uiE2eScoping.satisfied) {
    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.RUN_UI_E2E_SUITE]);
    pushUnique(forbiddenActions, [
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ]);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: DISPOSITION.ACTION_REQUIRED,
      gateBoundary: PR_CHECKPOINT.UI_E2E_SCOPING,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.RUN_UI_E2E_SUITE,
      reason: uiE2eScoping.reason,
      mergeStateStatus,
      conflictFiles,
      refinementArtifact,
      copilotReviewRoundCount,
    });
  }

  if (prDraft || effectiveLifecycleState === STATE.PR_DRAFT) {
    if (refinementArtifactStatus === REFINEMENT_ARTIFACT_STATUS.MISSING) {
      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]);
      pushUnique(forbiddenActions, [
        PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
        PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
        PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
        PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW,
        PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
        PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
      ]);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: STATE.BLOCKED_NEEDS_USER_DECISION,
        loopDisposition: DISPOSITION.BLOCKED,
        gateBoundary: PR_CHECKPOINT.BLOCKED,
        draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.REPORT_BLOCKED,
        reason: formatRefinementBlockedReason(refinementLinkedIssue, refinementArtifactStatus, refinementArtifact),
        mergeStateStatus,
        conflictFiles,
        refinementArtifact,
      });
    }
    const draftReviewForbidden = [
      ...(draftGate.currentHeadClean ? [] : [PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW]),
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ];

    if (!draftGate.currentHeadClean && draftGateRequireCi) {
      if (ciStatus === "failure") {
        pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]);
        pushUnique(forbiddenActions, [
          PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
          ...draftReviewForbidden,
        ]);
        return buildResult({
          repo: input.repo ?? null,
          pr: Number.isInteger(input.pr) ? input.pr : null,
          currentHeadSha,
          lifecycleState: STATE.BLOCKED_NEEDS_USER_DECISION,
          loopDisposition: DISPOSITION.BLOCKED,
          gateBoundary: PR_CHECKPOINT.BLOCKED,
          draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
          draftGate,
          preApprovalGate,
          allowedNextActions,
          forbiddenActions,
          nextAction: PR_CHECKPOINT_ACTION.REPORT_BLOCKED,
          reason: "The PR is still draft, and this repo requires green current-head CI before entering `draft_gate`. The current head is failing CI, so fix the checks before retrying the draft gate.",
          mergeStateStatus,
          conflictFiles,
            refinementArtifact,
        });
      }

      if (ciStatus !== "success") {
        pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.WAIT_FOR_CI]);
        pushUnique(forbiddenActions, [
          PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
          ...draftReviewForbidden,
        ]);
        return buildResult({
          repo: input.repo ?? null,
          pr: Number.isInteger(input.pr) ? input.pr : null,
          currentHeadSha,
          lifecycleState: STATE.WAITING_FOR_CI,
          loopDisposition: DISPOSITION.PENDING,
          gateBoundary: PR_CHECKPOINT.DRAFT_REVIEW,
          draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
          draftGate,
          preApprovalGate,
          allowedNextActions,
          forbiddenActions,
          nextAction: PR_CHECKPOINT_ACTION.WAIT_FOR_CI,
          reason: "The PR is still draft, and this repo requires green current-head CI before entering `draft_gate`, so wait for CI to settle green before running the draft gate.",
          mergeStateStatus,
          conflictFiles,
            refinementArtifact,
        });
      }
    }

    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE]);
    if (draftGate.currentHeadClean) {
      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW]);
    }
    pushUnique(forbiddenActions, draftReviewForbidden);

    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: lifecycleState || STATE.PR_DRAFT,
      loopDisposition: loopDisposition ?? DISPOSITION.ACTION_REQUIRED,
      gateBoundary: PR_CHECKPOINT.DRAFT_REVIEW,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: draftGate.currentHeadClean ? PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW : PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      reason: draftGate.currentHeadClean
        ? "The PR is still draft, and current-head clean `draft_gate` evidence exists, so `gh pr ready` is now legal."
        : (draftGateRequireCi
          ? "The PR is still draft, current-head CI is green, and `draft_gate` is now the legal gate boundary before `gh pr ready`."
          : "The PR is still draft, and this repo does not require CI before `draft_gate`, so the draft gate is the next legal boundary before `gh pr ready`."),
      mergeStateStatus,
      conflictFiles,
        refinementArtifact,
    copilotReviewRoundCount,
    });
  }

  const postDraftForbidden = [
    PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
    PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
    PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
    PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
  ];

  const internalOnlyPostDraftForbidden = [
    PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
    PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
    PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
    PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
  ];

  if (effectiveLifecycleState === STATE.PR_READY_NO_FEEDBACK) {
    if (reviewMode === "internal_only") {
      // Explicitly internal-only PR: skip the external Copilot review cycle
      if (preApprovalRequireCi && (ciStatus === "failure" || ciStatus === "crediblyGreen")) {
        pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]);
        pushUnique(forbiddenActions, internalOnlyPostDraftForbidden);
        return buildResult({
          repo: input.repo ?? null,
          pr: Number.isInteger(input.pr) ? input.pr : null,
          currentHeadSha,
          lifecycleState: STATE.BLOCKED_NEEDS_USER_DECISION,
          loopDisposition: DISPOSITION.BLOCKED,
          gateBoundary: PR_CHECKPOINT.BLOCKED,
          draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
          draftGate,
          preApprovalGate,
          allowedNextActions,
          forbiddenActions,
          nextAction: PR_CHECKPOINT_ACTION.REPORT_BLOCKED,
          reason: ciStatus === "crediblyGreen"
            ? "The current head has unconfirmed CI (credibly green), so gate progression remains blocked until CI is confirmed green."
            : "The current head has failing CI, so gate progression remains blocked until the failing checks are fixed and revalidated.",
          mergeStateStatus,
          conflictFiles,
            refinementArtifact,
        });
      }
      if (preApprovalGate.currentHeadClean) {
        const titleMarkers = findBlockingTitleMarkers(prTitle);
        if (titleMarkers.length > 0) {
          return buildTitleMarkerBlockedResult({
            input,
            currentHeadSha,
            draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
            draftGate,
            preApprovalGate,
            mergeStateStatus,
            conflictFiles,
            markers: titleMarkers,
            refinementArtifact,
          });
        }
        if (!draftGate.cleanEvidenceExists) {
          return buildDraftGateNeededForMergeResult({
            input,
            currentHeadSha,
            draftGate,
            preApprovalGate,
            mergeStateStatus,
            conflictFiles,
            underlyingReason: "Internal-only PR reached pre_approval_gate clean but has no clean draft_gate evidence.",
            refinementArtifact,
            effectiveLifecycleState,
          });
        }

        pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL]);
        pushUnique(forbiddenActions, internalOnlyPostDraftForbidden);
        return buildResult({
          repo: input.repo ?? null,
          pr: Number.isInteger(input.pr) ? input.pr : null,
          currentHeadSha,
          lifecycleState: effectiveLifecycleState,
          loopDisposition: loopDisposition ?? DISPOSITION.CLEAN_CONVERGED,
          gateBoundary: PR_CHECKPOINT.FINAL_APPROVAL_READY,
          draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
          draftGate,
          preApprovalGate,
          allowedNextActions,
          forbiddenActions,
          nextAction: PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
          reason: copilotReviewDisabled
            ? "Copilot review is disabled for this repo (maxCopilotRounds: 0); with clean draft_gate evidence and current-head clean pre_approval_gate, the PR is ready for final human approval."
            : "This is an explicitly internal-only PR with clean draft_gate evidence and current-head clean pre_approval_gate, so it is ready for final human approval.",
          mergeStateStatus,
          conflictFiles,
            refinementArtifact,
        });
      }

      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE]);
      pushUnique(forbiddenActions, internalOnlyPostDraftForbidden);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: effectiveLifecycleState,
        loopDisposition: loopDisposition ?? DISPOSITION.ACTION_REQUIRED,
        gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
        draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
        reason: copilotReviewDisabled
          ? "Copilot review is disabled for this repo (maxCopilotRounds: 0), so `pre_approval_gate` is the next legal boundary instead of an external Copilot review cycle."
          : "This is an explicitly internal-only PR, so `pre_approval_gate` is the next legal boundary instead of an external Copilot review cycle.",
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }

    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW]);
    pushUnique(forbiddenActions, postDraftForbidden);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: loopDisposition ?? DISPOSITION.ACTION_REQUIRED,
      gateBoundary: PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      reason: "The PR is ready for review but the post-draft external review cycle has not started yet; request Copilot review before any `pre_approval_gate` entry.",
      mergeStateStatus,
      conflictFiles,
        refinementArtifact,
    copilotReviewRoundCount,
    });
  }

  if (effectiveLifecycleState === STATE.WAITING_FOR_COPILOT_REVIEW || effectiveLifecycleState === STATE.WAITING_FOR_CI) {
    const waitAction = effectiveLifecycleState === STATE.WAITING_FOR_CI
      ? PR_CHECKPOINT_ACTION.WAIT_FOR_CI
      : PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW;

    pushUnique(allowedNextActions, [waitAction]);
    pushUnique(forbiddenActions, postDraftForbidden);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: loopDisposition ?? DISPOSITION.PENDING,
      gateBoundary: PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: waitAction,
      reason: effectiveLifecycleState === STATE.WAITING_FOR_CI
        ? "The post-draft review cycle is waiting on current-head CI, so `pre_approval_gate` remains illegal until CI settles cleanly."
        : "The post-draft review cycle is still pending on Copilot review, so `pre_approval_gate` remains illegal until the current-head review cycle settles.",
      mergeStateStatus,
      conflictFiles,
        refinementArtifact,
    copilotReviewRoundCount,
    });
  }

  if (effectiveLifecycleState === STATE.UNRESOLVED_FEEDBACK_PRESENT) {
    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.ADDRESS_REVIEW_FEEDBACK]);
    pushUnique(forbiddenActions, postDraftForbidden);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: loopDisposition ?? DISPOSITION.UNRESOLVED_FEEDBACK,
      gateBoundary: PR_CHECKPOINT.FEEDBACK_RESOLUTION,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.ADDRESS_REVIEW_FEEDBACK,
      reason: "Actionable unresolved feedback exists, so follow-up work must stay in the review/fix cycle and cannot enter `pre_approval_gate` yet.",
      mergeStateStatus,
      conflictFiles,
        refinementArtifact,
    copilotReviewRoundCount,
    });
  }

  if (effectiveLifecycleState === STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE) {
    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPLY_RESOLVE_REVIEW_THREADS]);
    pushUnique(forbiddenActions, postDraftForbidden);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: loopDisposition ?? DISPOSITION.UNRESOLVED_FEEDBACK,
      gateBoundary: PR_CHECKPOINT.FEEDBACK_RESOLUTION,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.REPLY_RESOLVE_REVIEW_THREADS,
      reason: "Fixes were applied, but unresolved threads still need reply/resolve handling before another gate boundary is legal.",
      mergeStateStatus,
      conflictFiles,
        refinementArtifact,
    copilotReviewRoundCount,
    });
  }

  if (effectiveLifecycleState === STATE.READY_TO_REREQUEST_REVIEW) {
    if (preApprovalRequireCi && (ciStatus === "failure" || ciStatus === "crediblyGreen")) {
      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]);
      pushUnique(forbiddenActions, postDraftForbidden);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: STATE.BLOCKED_NEEDS_USER_DECISION,
        loopDisposition: DISPOSITION.BLOCKED,
        gateBoundary: PR_CHECKPOINT.BLOCKED,
        draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.REPORT_BLOCKED,
        reason: ciStatus === "crediblyGreen"
          ? "The current head has unconfirmed CI (credibly green), so gate progression remains blocked until CI is confirmed green."
          : "The current head still has failing CI, so gate progression remains blocked until the failing checks are fixed and revalidated.",
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }

    if (preApprovalRequireCi && (ciStatus === "pending" || ciStatus === "none")) {
      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.WAIT_FOR_CI]);
      pushUnique(forbiddenActions, postDraftForbidden);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: STATE.WAITING_FOR_CI,
        loopDisposition: DISPOSITION.PENDING,
        gateBoundary: PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
        draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.WAIT_FOR_CI,
        reason: "The current head does not yet have green or credibly green CI, so `pre_approval_gate` remains illegal until CI settles.",
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }

    const roundExhaustionGateEvidenceNote = (roundCapReached && !roundCapNewCycleRequired)
      ? buildRoundExhaustionGateEvidenceNote({ copilotReviewRoundCount, maxCopilotRounds })
      : null;

    if (!sameHeadCleanConverged && (!roundCapReached || roundCapNewCycleRequired)) {
      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW]);
      pushUnique(forbiddenActions, postDraftForbidden);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: effectiveLifecycleState,
        loopDisposition: loopDisposition ?? DISPOSITION.ACTION_REQUIRED,
        gateBoundary: PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
        draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW,
        reason: roundCapNewCycleRequired
          ? "The previous Copilot cycle converged at the round cap, but significant post-convergence changes landed on a newer head; start a new Copilot review cycle and re-request review before `pre_approval_gate`."
          : "The review loop is between passes, but the current head does not yet have a clean settled Copilot convergence point, so `pre_approval_gate` is still forbidden.",
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }

    if (preApprovalGate.currentHeadClean) {
      const titleMarkers = findBlockingTitleMarkers(prTitle);
      if (titleMarkers.length > 0) {
        return buildTitleMarkerBlockedResult({
          input,
          currentHeadSha,
          draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
          draftGate,
          preApprovalGate,
          mergeStateStatus,
          conflictFiles,
          markers: titleMarkers,
          refinementArtifact,
        });
      }

      if (!draftGate.cleanEvidenceExists && !roundCapReached) {
        return buildDraftGateNeededForMergeResult({
          input,
          currentHeadSha,
          draftGate,
          preApprovalGate,
          mergeStateStatus,
          conflictFiles,
          underlyingReason: "Converged PR has clean pre_approval_gate but no clean draft_gate evidence.",
          refinementArtifact,
          effectiveLifecycleState,
        });
      }

      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL]);
      pushUnique(forbiddenActions, [
        PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
        PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
        PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
        PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
      ]);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: effectiveLifecycleState,
        loopDisposition: loopDisposition ?? DISPOSITION.CLEAN_CONVERGED,
        gateBoundary: PR_CHECKPOINT.FINAL_APPROVAL_READY,
        draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
        reason: roundCapReached
          ? `Round-cap clean fallback accepted as draft gate equivalent (${copilotReviewRoundCount}/${maxCopilotRounds} rounds, zero unresolved threads, ${ciStatus === "crediblyGreen" ? "credibly green" : "green"} CI). The current head has clean \`pre_approval_gate\` evidence, so the PR is at the final approval boundary.`
          : (ciStatus === "crediblyGreen"
            ? "The current head has both a clean settled review cycle and clean `pre_approval_gate` evidence, and its zero-suite CI state is accepted as credibly green, so the PR is at the final approval boundary."
            : "The current head has both a clean settled review cycle and clean `pre_approval_gate` evidence, so the PR is at the final approval boundary."),
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }

    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE]);
    pushUnique(forbiddenActions, [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ]);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: loopDisposition ?? DISPOSITION.CLEAN_CONVERGED,
      gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      reason: roundCapReached
        ? `The Copilot round limit is exhausted (${copilotReviewRoundCount}/${maxCopilotRounds}), and the current head has zero unresolved threads with ${ciStatus === "crediblyGreen" ? "credibly green" : "green"} CI, so \`pre_approval_gate\` fallback is now the next legal boundary.`
        : (ciStatus === "crediblyGreen"
          ? "The current head has a clean settled post-draft review cycle, and its zero-suite CI state is accepted as credibly green, so `pre_approval_gate` is now the next legal boundary."
          : "The current head has a clean settled post-draft review cycle, so `pre_approval_gate` is now the next legal boundary."),
      mergeStateStatus,
      conflictFiles,
      gateEvidenceNote: roundCapReached ? roundExhaustionGateEvidenceNote : null,
    copilotReviewRoundCount,
    });
  }

  // Round-cap clean fallback (#896, #848): the Copilot review round cap is
  // exhausted and the current head is clean (zero unresolved threads + green CI)
  // — including a POST-CAP head Copilot has not (and will not) re-review, since
  // no further Copilot round is permitted. Re-requesting review is illegal here,
  // so this MUST NOT dead-end at READY_TO_REREQUEST_REVIEW — nor at a forced
  // rerequest for a post-convergence significant change (#1387): the cap makes
  // that rerequest impossible (request-copilot-review suppresses it), so a
  // significant change discovered here is reviewed by the pre_approval_gate
  // fan-out itself, on the post-cap head, same as any other clean fallback. It
  // routes to the pre_approval_gate, which reviews the post-cap head itself
  // (per #848). The CI guards below still hold (failing / credibly-green CI
  // blocks), and conflicts / blocked states are handled earlier, so
  // genuinely-blocked states still forbid pre_approval. Mirrors
  // LOW_SIGNAL_CONVERGED routing with round-cap reasoning.
  if (effectiveLifecycleState === STATE.ROUND_CAP_CLEAN_FALLBACK) {
    if (preApprovalRequireCi && (ciStatus === "failure" || ciStatus === "crediblyGreen")) {
      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]);
      pushUnique(forbiddenActions, postDraftForbidden);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: STATE.BLOCKED_NEEDS_USER_DECISION,
        loopDisposition: DISPOSITION.BLOCKED,
        gateBoundary: PR_CHECKPOINT.BLOCKED,
        draftGateAlreadySatisfied: true,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.REPORT_BLOCKED,
        reason: ciStatus === "crediblyGreen"
          ? "The Copilot round cap is exhausted, but the current head has unconfirmed CI (credibly green), so gate progression remains blocked until CI is confirmed green."
          : "The Copilot round cap is exhausted, but the current head still has failing CI, so gate progression remains blocked until the failing checks are fixed and revalidated.",
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }
    if (preApprovalRequireCi && (ciStatus === "pending" || ciStatus === "none")) {
      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.WAIT_FOR_CI]);
      pushUnique(forbiddenActions, postDraftForbidden);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: STATE.WAITING_FOR_CI,
        loopDisposition: DISPOSITION.PENDING,
        gateBoundary: PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
        draftGateAlreadySatisfied: true,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.WAIT_FOR_CI,
        reason: "The Copilot round cap is exhausted, but the current head does not yet have green or credibly green CI, so `pre_approval_gate` remains illegal until CI settles.",
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }
    if (preApprovalGate.currentHeadClean) {
      const titleMarkers = findBlockingTitleMarkers(prTitle);
      if (titleMarkers.length > 0) {
        return buildTitleMarkerBlockedResult({
          input,
          currentHeadSha,
          draftGateAlreadySatisfied: true,
          draftGate,
          preApprovalGate,
          mergeStateStatus,
          conflictFiles,
          markers: titleMarkers,
          refinementArtifact,
        });
      }
      // Mirror LOW_SIGNAL_CONVERGED (#579): a clean current head with no clean
      // draft_gate evidence must reconcile the draft gate rather than jump to
      // final approval. This keeps the core handler consistent with the
      // detect-pr-gate-coordination-state #579 post-pass, which unconditionally
      // downgrades FINAL_APPROVAL_READY → DRAFT_GATE_NEEDED when
      // draftGate.cleanEvidenceExists is false (no ROUND_CAP_CLEAN_FALLBACK
      // exemption). Without this guard the final-approval-without-draft-gate
      // branch is dead through the real script and asserts behavior it never
      // produces.
      if (!draftGate.cleanEvidenceExists) {
        return buildDraftGateNeededForMergeResult({
          input,
          currentHeadSha,
          draftGate,
          preApprovalGate,
          mergeStateStatus,
          conflictFiles,
          underlyingReason: "Round-cap clean fallback has clean pre_approval_gate but no clean draft_gate evidence.",
          refinementArtifact,
          effectiveLifecycleState,
        });
      }

      // Round-cap clean fallback with clean draft_gate evidence reaches final
      // approval when the current head also has clean pre_approval_gate evidence.
      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL]);
      pushUnique(forbiddenActions, [
        PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
        PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
        PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
        PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
      ]);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: effectiveLifecycleState,
        loopDisposition: loopDisposition ?? DISPOSITION.CLEAN_CONVERGED,
        gateBoundary: PR_CHECKPOINT.FINAL_APPROVAL_READY,
        draftGateAlreadySatisfied: true,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
        reason: `Round-cap clean fallback accepted as draft gate equivalent (${copilotReviewRoundCount}/${maxCopilotRounds} rounds, zero unresolved threads, ${ciStatus === "crediblyGreen" ? "credibly green" : "green"} CI). The current head has clean \`pre_approval_gate\` evidence, so the PR is at the final approval boundary.`,
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }
    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE]);
    pushUnique(forbiddenActions, [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ]);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: loopDisposition ?? DISPOSITION.CLEAN_CONVERGED,
      gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
      draftGateAlreadySatisfied: true,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      reason: `The Copilot round limit is exhausted (${copilotReviewRoundCount}/${maxCopilotRounds}), and the current head has zero unresolved threads with ${ciStatus === "crediblyGreen" ? "credibly green" : "green"} CI, so \`pre_approval_gate\` fallback is now the next legal boundary (it reviews the current post-cap head; no further Copilot re-request is permitted).`,
      mergeStateStatus,
      conflictFiles,
      refinementArtifact,
      gateEvidenceNote: buildRoundExhaustionGateEvidenceNote({ copilotReviewRoundCount, maxCopilotRounds }),
    copilotReviewRoundCount,
    });
  }

  // Defensive gate-entry re-check for ROUND_CAP_REACHED (#1472): the compound
  // "unresolved threads OR non-clean CI" hard stop that copilot-loop-state.mjs
  // emits has no dedicated boundary of its own, so without this branch the
  // generic fallback below always names `report_blocked`. This branch exists
  // for a caller re-checking gate entry with signals fresher than the
  // interpreter's snapshot (e.g. threads resolved between the interpreter run
  // and this re-check) — it is NOT how a normal ROUND_CAP_REACHED classification
  // is expected to look, because the interpreter uses the SAME strict-CI
  // predicate below: whenever that predicate and zero unresolved threads both
  // hold on the snapshot the interpreter itself observed, the interpreter emits
  // ROUND_CAP_CLEAN_FALLBACK instead of ROUND_CAP_REACHED (see the
  // equivalence test in pr-gate-coordination.test.mjs). So on facts unchanged
  // since interpretation, this branch never fires; it only grants when the
  // caller's re-check facts diverge from what the interpreter last saw. The
  // predicate intentionally mirrors every other pre-approval CI boundary in
  // this file (success, or CI not required) — `crediblyGreen` is unconfirmed
  // CI and stays blocked here exactly as it does everywhere else (#1371). Any
  // other combination (threads still unresolved, an unknown thread count, or
  // CI not confirmed green) falls through unchanged to the generic default
  // below, preserving today's blocked behavior exactly.
  if (effectiveLifecycleState === STATE.ROUND_CAP_REACHED && roundCapReached) {
    const ciConfirmedGreen = ciStatus === "success" || !preApprovalRequireCi;
    // ciConfirmedGreen above is only true when ciStatus is literally "success"
    // OR CI is not required by config — never for an unconfirmed/failing/absent
    // status gated in only because requireCi is false. Naming it "green" in
    // human-read reason/evidence text for the latter case would be a false CI
    // claim (#1472 defer), so describe the actual grant basis instead.
    const ciClause = ciStatus === "success" ? "green CI" : "CI not required by config";
    if (unresolvedThreadCount === 0 && ciConfirmedGreen) {
      if (preApprovalGate.currentHeadClean) {
        const titleMarkers = findBlockingTitleMarkers(prTitle);
        if (titleMarkers.length > 0) {
          return buildTitleMarkerBlockedResult({
            input,
            currentHeadSha,
            draftGateAlreadySatisfied: true,
            draftGate,
            preApprovalGate,
            mergeStateStatus,
            conflictFiles,
            markers: titleMarkers,
            refinementArtifact,
          });
        }
        // Mirror ROUND_CAP_CLEAN_FALLBACK/#579: a clean current head with no clean
        // draft_gate evidence must reconcile the draft gate rather than jump to
        // final approval.
        if (!draftGate.cleanEvidenceExists) {
          return buildDraftGateNeededForMergeResult({
            input,
            currentHeadSha,
            draftGate,
            preApprovalGate,
            mergeStateStatus,
            conflictFiles,
            underlyingReason: "Round-cap exhaustion fallback has clean pre_approval_gate but no clean draft_gate evidence.",
            refinementArtifact,
            effectiveLifecycleState,
          });
        }

        pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL]);
        pushUnique(forbiddenActions, [
          PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
          PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
          PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
          PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
        ]);
        return buildResult({
          repo: input.repo ?? null,
          pr: Number.isInteger(input.pr) ? input.pr : null,
          currentHeadSha,
          lifecycleState: effectiveLifecycleState,
          loopDisposition: loopDisposition ?? DISPOSITION.CLEAN_CONVERGED,
          gateBoundary: PR_CHECKPOINT.FINAL_APPROVAL_READY,
          draftGateAlreadySatisfied: true,
          draftGate,
          preApprovalGate,
          allowedNextActions,
          forbiddenActions,
          nextAction: PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
          reason: `Round-cap exhaustion fallback accepted as draft gate equivalent (${copilotReviewRoundCount}/${maxCopilotRounds} rounds, zero unresolved threads, ${ciClause}). The current head has clean \`pre_approval_gate\` evidence, so the PR is at the final approval boundary.`,
          mergeStateStatus,
          conflictFiles,
          refinementArtifact,
        });
      }

      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE]);
      pushUnique(forbiddenActions, [
        PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
        PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
        PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
        PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW,
        PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
      ]);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: effectiveLifecycleState,
        loopDisposition: loopDisposition ?? DISPOSITION.CLEAN_CONVERGED,
        gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
        draftGateAlreadySatisfied: true,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
        reason: `The Copilot round limit is exhausted (${copilotReviewRoundCount}/${maxCopilotRounds}), and the current head has zero unresolved threads and ${ciClause}, so \`pre_approval_gate\` fallback is now the next legal boundary (it reviews the current post-cap head; no further Copilot re-request is permitted).`,
        mergeStateStatus,
        conflictFiles,
        refinementArtifact,
        gateEvidenceNote: buildRoundExhaustionGateEvidenceNote({ copilotReviewRoundCount, maxCopilotRounds, ciStatus, preApprovalRequireCi }),
        copilotReviewRoundCount,
      });
    }
  }

  if (effectiveLifecycleState === STATE.LOW_SIGNAL_CONVERGED) {
    if (preApprovalRequireCi && (ciStatus === "failure" || ciStatus === "crediblyGreen")) {
      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]);
      pushUnique(forbiddenActions, postDraftForbidden);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: STATE.BLOCKED_NEEDS_USER_DECISION,
        loopDisposition: DISPOSITION.BLOCKED,
        gateBoundary: PR_CHECKPOINT.BLOCKED,
        draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.REPORT_BLOCKED,
        reason: ciStatus === "crediblyGreen"
          ? "The low-signal heuristic indicates convergence, but the current head has unconfirmed CI (credibly green), so gate progression remains blocked until CI is confirmed green."
          : "The low-signal heuristic indicates convergence, but the current head still has failing CI, so gate progression remains blocked.",
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }
    if (preApprovalRequireCi && (ciStatus === "pending" || ciStatus === "none")) {
      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.WAIT_FOR_CI]);
      pushUnique(forbiddenActions, postDraftForbidden);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: STATE.WAITING_FOR_CI,
        loopDisposition: DISPOSITION.PENDING,
        gateBoundary: PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
        draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.WAIT_FOR_CI,
        reason: "The low-signal heuristic indicates convergence, but the current head does not yet have green or credibly green CI.",
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }
    if (preApprovalGate.currentHeadClean) {
      const titleMarkers = findBlockingTitleMarkers(prTitle);
      if (titleMarkers.length > 0) {
        return buildTitleMarkerBlockedResult({
          input,
          currentHeadSha,
          draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
          draftGate,
          preApprovalGate,
          mergeStateStatus,
          conflictFiles,
          markers: titleMarkers,
          refinementArtifact,
        });
      }

      if (!draftGate.cleanEvidenceExists) {
        return buildDraftGateNeededForMergeResult({
          input,
          currentHeadSha,
          draftGate,
          preApprovalGate,
          mergeStateStatus,
          conflictFiles,
          underlyingReason: "Low-signal converged PR has clean pre_approval_gate but no clean draft_gate evidence.",
          refinementArtifact,
          effectiveLifecycleState,
        });
      }

      pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL]);
      pushUnique(forbiddenActions, [
        PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
        PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
        PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
        PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
      ]);
      return buildResult({
        repo: input.repo ?? null,
        pr: Number.isInteger(input.pr) ? input.pr : null,
        currentHeadSha,
        lifecycleState: effectiveLifecycleState,
        loopDisposition: DISPOSITION.DONE,
        gateBoundary: PR_CHECKPOINT.FINAL_APPROVAL_READY,
        draftGateAlreadySatisfied: roundCapReached ? true : draftGateAlreadySatisfied,
        draftGate,
        preApprovalGate,
        allowedNextActions,
        forbiddenActions,
        nextAction: PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
        reason: "Low-signal heuristic indicates convergence and current-head clean pre_approval_gate evidence exists.",
        mergeStateStatus,
        conflictFiles,
          refinementArtifact,
      });
    }
    pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE]);
    pushUnique(forbiddenActions, [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ]);
    return buildResult({
      repo: input.repo ?? null,
      pr: Number.isInteger(input.pr) ? input.pr : null,
      currentHeadSha,
      lifecycleState: effectiveLifecycleState,
      loopDisposition: DISPOSITION.DONE,
      gateBoundary: PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
      draftGateAlreadySatisfied,
      draftGate,
      preApprovalGate,
      allowedNextActions,
      forbiddenActions,
      nextAction: PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      reason: "Low-signal heuristic indicates convergence (diminishing-returns signal detected), routing to pre_approval_gate instead of re-requesting Copilot.",
      mergeStateStatus,
      conflictFiles,
        refinementArtifact,
    copilotReviewRoundCount,
    });
  }

  pushUnique(allowedNextActions, [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]);
  pushUnique(forbiddenActions, [
    PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
    PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
    PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
    PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
    PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
  ]);
  return buildResult({
    repo: input.repo ?? null,
    pr: Number.isInteger(input.pr) ? input.pr : null,
    currentHeadSha,
    lifecycleState: effectiveLifecycleState,
    loopDisposition: loopDisposition ?? DISPOSITION.BLOCKED,
    gateBoundary: PR_CHECKPOINT.BLOCKED,
    draftGateAlreadySatisfied,
    draftGate,
    preApprovalGate,
    allowedNextActions,
    forbiddenActions,
    nextAction: PR_CHECKPOINT_ACTION.REPORT_BLOCKED,
    reason: "The PR gate-boundary evaluator could not map this lifecycle state to a legal gate transition; reconcile before continuing.",
    mergeStateStatus,
    conflictFiles,
      refinementArtifact,
  });
}
