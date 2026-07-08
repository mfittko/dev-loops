import {
  evaluateRetrospectiveGate,
  normalizeRetrospectiveCheckpointState,
} from "./retrospective-checkpoint.mjs";
import {
  EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
  PERSISTENT_INTERNAL_WAIT_TIMEOUT_POLICY,
} from "./timeout-policy.mjs";
import {
  DEV_LOOP_ACTOR,
  DEV_LOOP_ARTIFACT_STATE,
  DEV_LOOP_AUTHORIZATION,
  DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION,
  DEV_LOOP_EXECUTION_MODE,
  DEV_LOOP_GATE,
  DEV_LOOP_ISSUE_ASSIGNMENT_SEAM,
  DEV_LOOP_ISSUE_ASSIGNMENT_STATE,
  DEV_LOOP_ISSUE_LINKAGE_RESOLUTION,
  DEV_LOOP_ISSUE_READINESS,
  DEV_LOOP_PUBLIC_INTENT,
  DEV_LOOP_ROUTE_KIND,
  DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND,
  DEV_LOOP_STATUS,
  DEV_LOOP_STATUS_REPORT_KIND,
  DEV_LOOP_TARGET_KIND,
  DEV_LOOP_TARGET_PREFERENCE,
  DEV_LOOP_VARIATION_PARAMETER_CONTRACT,
  DEV_LOOP_WAIT_SEMANTICS,
  INTERNAL_DEV_LOOP_STRATEGY,
  PUBLIC_DEV_LOOP_ENTRYPOINT,
} from "./public-dev-loop-routing-contract.mjs";

export * from "./public-dev-loop-routing-contract.mjs";

const COPILOT_ISSUE_ASSIGNEE = "copilot-swe-agent";

const TARGET_KIND_SET = new Set(Object.values(DEV_LOOP_TARGET_KIND));
const ACTOR_SET = new Set(Object.values(DEV_LOOP_ACTOR));
const STATUS_SET = new Set(Object.values(DEV_LOOP_STATUS));
const AUTHORIZATION_SET = new Set(Object.values(DEV_LOOP_AUTHORIZATION));
const INTENT_SET = new Set(Object.values(DEV_LOOP_PUBLIC_INTENT));
const ARTIFACT_STATE_SET = new Set(Object.values(DEV_LOOP_ARTIFACT_STATE));
const ISSUE_LINKAGE_RESOLUTION_SET = new Set(Object.values(DEV_LOOP_ISSUE_LINKAGE_RESOLUTION));
const ISSUE_READINESS_SET = new Set(Object.values(DEV_LOOP_ISSUE_READINESS));
const ISSUE_ASSIGNMENT_STATE_SET = new Set(Object.values(DEV_LOOP_ISSUE_ASSIGNMENT_STATE));
const VARIATION_MODE_SET = new Set(DEV_LOOP_VARIATION_PARAMETER_CONTRACT.allowedModeValues);
const TARGET_PREFERENCE_SET = new Set(DEV_LOOP_VARIATION_PARAMETER_CONTRACT.allowedTargetPreferenceValues);
const GATE_REVIEW_VERDICT_SET = new Set(["clean", "findings_present", "blocked"]);
const ALLOWED_MODE_VALUES_TEXT = DEV_LOOP_VARIATION_PARAMETER_CONTRACT.allowedModeValues.join(", ");
const ALLOWED_TARGET_PREFERENCE_VALUES_TEXT = DEV_LOOP_VARIATION_PARAMETER_CONTRACT.allowedTargetPreferenceValues.join(", ");
const LINKED_PR_READY_FOR_FOLLOWUP_LOOP_STATE = "linked_pr_ready_for_followup";
const PRIOR_LINKED_PR_CLOSED_UNMERGED_LOOP_STATE = "prior_linked_pr_closed_unmerged";

function normalizeIntent(intent) {
  const normalized = typeof intent === "string" ? intent.trim().toLowerCase() : "";
  return INTENT_SET.has(normalized) ? normalized : null;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object") {
    return null;
  }

  const kind = typeof target.kind === "string" ? target.kind.trim().toLowerCase() : "";
  if (!TARGET_KIND_SET.has(kind)) {
    return null;
  }

  const issue = Number.isInteger(target.issue) && target.issue > 0 ? target.issue : null;
  const hasPr = Object.hasOwn(target, "pr") && target.pr !== null && target.pr !== undefined;
  const pr = Number.isInteger(target.pr) && target.pr > 0 ? target.pr : null;
  const hasLinkedPr = Object.hasOwn(target, "linkedPr") && target.linkedPr !== null && target.linkedPr !== undefined;
  const linkedPr = Number.isInteger(target.linkedPr) && target.linkedPr > 0 ? target.linkedPr : null;
  const branch = typeof target.branch === "string" && target.branch.trim().length > 0 ? target.branch.trim() : null;
  const phase = typeof target.phase === "string" && target.phase.trim().length > 0 ? target.phase.trim() : null;

  if (kind === DEV_LOOP_TARGET_KIND.ISSUE && issue === null) {
    return null;
  }
  if (kind === DEV_LOOP_TARGET_KIND.ISSUE && hasLinkedPr && linkedPr === null) {
    return null;
  }
  if (kind === DEV_LOOP_TARGET_KIND.ISSUE && hasPr) {
    return null;
  }
  if (kind === DEV_LOOP_TARGET_KIND.PR && pr === null) {
    return null;
  }
  if (kind === DEV_LOOP_TARGET_KIND.PR && hasLinkedPr) {
    return null;
  }
  if (kind === DEV_LOOP_TARGET_KIND.LOCAL_BRANCH && branch === null) {
    return null;
  }
  if (kind === DEV_LOOP_TARGET_KIND.LOCAL_PHASE && phase === null && issue === null) {
    return null;
  }

  return { kind, issue, pr, linkedPr, branch, phase };
}

function normalizeActor(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ACTOR_SET.has(normalized) ? normalized : null;
}

function normalizeSha(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeGateReviewVerdict(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return GATE_REVIEW_VERDICT_SET.has(normalized) ? normalized : null;
}

function normalizeGateReviewEvidence(evidence) {
  if (evidence === undefined || evidence === null) {
    return null;
  }
  if (typeof evidence !== "object") {
    return null;
  }

  const preApprovalGate = evidence.preApprovalGate;
  if (!preApprovalGate || typeof preApprovalGate !== "object") {
    return null;
  }

  return {
    currentHeadSha: normalizeSha(evidence.currentHeadSha),
    preApprovalGate: {
      visible: preApprovalGate.visible === true,
      headSha: normalizeSha(preApprovalGate.headSha),
      verdict: normalizeGateReviewVerdict(preApprovalGate.verdict),
    },
  };
}

function isFinalApprovalState(canonicalState) {
  return canonicalState.status === DEV_LOOP_STATUS.APPROVAL_READY
    || canonicalState.status === DEV_LOOP_STATUS.MERGE_READY;
}

function hasCleanVisibleCurrentHeadPreApprovalGate(gateReviewEvidence) {
  return gateReviewEvidence !== null
    && gateReviewEvidence.currentHeadSha !== null
    && gateReviewEvidence.preApprovalGate.visible
    && gateReviewEvidence.preApprovalGate.verdict === "clean"
    && gateReviewEvidence.preApprovalGate.headSha === gateReviewEvidence.currentHeadSha;
}

function normalizeState(currentState) {
  if (!currentState || typeof currentState !== "object") {
    return null;
  }

  const target = normalizeTarget(currentState.target);
  const ownership = normalizeActor(currentState.ownership);
  const nextActor = normalizeActor(currentState.nextActor);
  const status = typeof currentState.status === "string" ? currentState.status.trim().toLowerCase() : "";
  const authorization =
    typeof currentState.authorization === "string" ? currentState.authorization.trim().toLowerCase() : "";

  if (!target || !ownership || !nextActor || !STATUS_SET.has(status) || !AUTHORIZATION_SET.has(authorization)) {
    return null;
  }

  return { target, ownership, nextActor, status, authorization };
}

function normalizeArtifactState(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ARTIFACT_STATE_SET.has(normalized) ? normalized : null;
}

function normalizeOptionalLoopState(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0 || normalized.toLowerCase() === "unknown") {
    return null;
  }
  return normalized;
}

function normalizeAsyncRunId(value) {
  const asString = normalizeSha(value);
  if (asString !== null) return asString;
  return null;
}

function normalizeAsyncRun(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const kind = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "";
  if (kind !== "pi_managed_run" && kind !== "detached_process") {
    return null;
  }
  const hasInspectionState = value.inspectionState !== undefined && value.inspectionState !== null;
  const inspectionState = hasInspectionState
    ? (typeof value.inspectionState === "string" ? value.inspectionState.trim().toLowerCase() : "")
    : null;
  if (
    hasInspectionState
    && inspectionState !== "visible"
    && inspectionState !== "hidden"
    && inspectionState !== "stale"
    && inspectionState !== "uninspectable"
    && inspectionState !== "missing"
  ) {
    return null;
  }

  return {
    kind,
    runId: normalizeAsyncRunId(value.runId),
    visible: value.visible === true,
    inspectionState,
  };
}

function normalizeIssueLinkageResolution(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ISSUE_LINKAGE_RESOLUTION_SET.has(normalized) ? normalized : null;
}

function normalizeIssueReadiness(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ISSUE_READINESS_SET.has(normalized) ? normalized : null;
}

function normalizeIssueAssignmentState(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ISSUE_ASSIGNMENT_STATE_SET.has(normalized) ? normalized : null;
}

function normalizeVariationMode(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VARIATION_MODE_SET.has(normalized) ? normalized : null;
}

function normalizeTargetPreference(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TARGET_PREFERENCE_SET.has(normalized) ? normalized : null;
}

function applyRetrospectiveCheckpointGate(result, checkpointState, checkpointStateProvided) {
  if (!checkpointStateProvided) {
    return result;
  }

  return evaluateRetrospectiveGate({
    checkpointState,
    proposedRouting: result,
  });
}

function resolveStopClassification({ selectedGate, routeKind, canonicalState = null }) {
  if (routeKind === DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE || selectedGate === DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE) {
    return DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.RECONCILE;
  }

  if (routeKind === DEV_LOOP_ROUTE_KIND.INSPECT) {
    return DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.INSPECT;
  }

  if (routeKind === DEV_LOOP_ROUTE_KIND.WAIT) {
    return DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.HEALTHY_WAIT;
  }

  if (selectedGate === DEV_LOOP_GATE.STOP_DONE_TERMINAL || canonicalState?.status === DEV_LOOP_STATUS.DONE) {
    return DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.TERMINAL;
  }

  if (selectedGate === DEV_LOOP_GATE.WAITING_FOR_MERGE_AUTHORIZATION) {
    return DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.AUTHORIZATION_GATED;
  }

  if (selectedGate === DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED) {
    return canonicalState?.status === DEV_LOOP_STATUS.BLOCKED
      ? DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.BLOCKED
      : DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.AUTHORIZATION_GATED;
  }

  if (routeKind === DEV_LOOP_ROUTE_KIND.STOP) {
    return DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.BLOCKED;
  }

  return DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.ROUTED_FOLLOWUP;
}

function buildContractTrace({
  publicEntrypoint = PUBLIC_DEV_LOOP_ENTRYPOINT,
  selectedGate,
  routeKind,
  selectedStrategy,
  executionMode,
  waitSemantics,
  waitTimeoutPolicy,
  canonicalState,
  reason,
  watchRequested = false,
  boundary = null,
}) {
  const effectiveTimeoutMs = waitTimeoutPolicy?.defaultTimeoutMs ?? null;
  return {
    publicEntrypoint,
    decision: {
      selectedGate,
      routeKind,
      selectedStrategy,
      executionMode,
      watchRequested,
      contractClassification: resolveStopClassification({ selectedGate, routeKind, canonicalState }),
      contractJustification: reason,
    },
    waitStrategy: {
      selectedStrategy: routeKind === DEV_LOOP_ROUTE_KIND.WAIT ? selectedStrategy : null,
      waitSemantics,
      waitMode: routeKind === DEV_LOOP_ROUTE_KIND.WAIT ? "persistent_watch" : "not_applicable",
      timeoutPolicyClassification: waitTimeoutPolicy?.classification ?? null,
      effectiveTimeoutMs,
      effectivePollIntervalMs: null,
    },
    stopReason: {
      classification: resolveStopClassification({ selectedGate, routeKind, canonicalState }),
      terminal: selectedGate === DEV_LOOP_GATE.STOP_DONE_TERMINAL || canonicalState?.status === DEV_LOOP_STATUS.DONE,
      reason,
    },
    stateRefresh: boundary ?? null,
  };
}

function withContractTrace(result, { watchRequested = false, boundary = null } = {}) {
  return {
    ...result,
    contractTrace: buildContractTrace({
      ...result,
      watchRequested,
      boundary,
    }),
  };
}

function buildResult({
  selectedGate,
  routeKind,
  selectedStrategy,
  canonicalState,
  nextAction,
  reason,
  executionMode = DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
  waitSemantics = DEV_LOOP_WAIT_SEMANTICS.DEFAULT,
  waitTimeoutPolicy = null,
  issueAssignmentSeam = DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.NOT_APPLICABLE,
  watchRequested = false,
  contractTraceBoundary = null,
}) {
  return {
    publicEntrypoint: PUBLIC_DEV_LOOP_ENTRYPOINT,
    selectedGate,
    routeKind,
    selectedStrategy,
    executionMode,
    waitSemantics,
    waitTimeoutPolicy,
    canonicalState,
    issueAssignmentSeam,
    nextAction,
    reason,
    contractTrace: buildContractTrace({
      selectedGate,
      routeKind,
      selectedStrategy,
      executionMode,
      waitSemantics,
      waitTimeoutPolicy,
      canonicalState,
      reason,
      watchRequested,
      boundary: contractTraceBoundary,
    }),
  };
}

function buildReconcile(
  reason,
  canonicalState = null,
  executionMode = DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
  { watchRequested = false, contractTraceBoundary = null } = {},
) {
  return buildResult({
    selectedGate: DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE,
    routeKind: DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
    executionMode,
    canonicalState,
    nextAction: "Stop and reconcile the canonical current state before choosing an internal strategy.",
    reason,
    watchRequested,
    contractTraceBoundary,
  });
}

/**
 * Post-routing validation for the `watch` variation parameter.
 * If watch was explicitly requested, the routed result must be wait/watch-capable
 * before watch semantics can be added.
 * Existing stop and needs_reconcile results are preserved; only otherwise-successful
 * non-wait routed results fail closed.
 */
function applyWatchValidation(result, watchRequested) {
  const refreshBoundary = watchRequested
    ? {
        boundaryKind: "post_watch_or_probe",
        refreshRequired: true,
        refreshReason: result.routeKind === DEV_LOOP_ROUTE_KIND.WAIT
          ? "Wait/watch boundaries are observational only; refresh authoritative state before treating a healthy wait boundary as completion or exit."
          : "Requested watch/probe boundaries still require an authoritative state refresh before classifying the outcome as completion or re-entry.",
      }
    : null;

  if (!watchRequested) return result;
  if (result.routeKind === DEV_LOOP_ROUTE_KIND.WAIT) {
    return withContractTrace(result, { watchRequested, boundary: refreshBoundary });
  }
  if (result.routeKind === DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE) return withContractTrace(result, { watchRequested });
  if (result.routeKind === DEV_LOOP_ROUTE_KIND.STOP) return withContractTrace(result, { watchRequested });
  if (result.selectedGate === DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE) return withContractTrace(result, { watchRequested });
  if (result.selectedGate === DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED) return withContractTrace(result, { watchRequested });
  if (result.selectedGate === DEV_LOOP_GATE.STOP_DONE_TERMINAL) return withContractTrace(result, { watchRequested });
  return buildReconcile(
    "watch requested but the routed result is not eligible for wait/watch semantics.",
    result.canonicalState,
    result.executionMode,
    { watchRequested, contractTraceBoundary: refreshBoundary },
  );
}

function toRoutableCanonicalState(canonicalState) {
  if (canonicalState.target.kind !== DEV_LOOP_TARGET_KIND.ISSUE || canonicalState.target.linkedPr === null) {
    return canonicalState;
  }

  return {
    ...canonicalState,
    target: {
      kind: DEV_LOOP_TARGET_KIND.PR,
      issue: canonicalState.target.issue,
      pr: canonicalState.target.linkedPr,
      linkedPr: null,
      branch: null,
      phase: null,
    },
  };
}

function selectGateForState(canonicalState, { uiReviewRequested = false } = {}) {
  if (canonicalState.status === DEV_LOOP_STATUS.BLOCKED || canonicalState.authorization === DEV_LOOP_AUTHORIZATION.NOT_AUTHORIZED) {
    return DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED;
  }

  if (canonicalState.status === DEV_LOOP_STATUS.DONE) {
    return DEV_LOOP_GATE.STOP_DONE_TERMINAL;
  }

  if (
    canonicalState.status === DEV_LOOP_STATUS.MERGE_READY
    && canonicalState.authorization === DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION
  ) {
    return DEV_LOOP_GATE.WAITING_FOR_MERGE_AUTHORIZATION;
  }

  if (
    canonicalState.status === DEV_LOOP_STATUS.APPROVAL_READY ||
    canonicalState.status === DEV_LOOP_STATUS.MERGE_READY
  ) {
    return DEV_LOOP_GATE.FINAL_APPROVAL;
  }

  if (canonicalState.status === DEV_LOOP_STATUS.WAITING) {
    return DEV_LOOP_GATE.WAIT_WATCH;
  }

  if (
    canonicalState.target.kind === DEV_LOOP_TARGET_KIND.LOCAL_BRANCH ||
    canonicalState.target.kind === DEV_LOOP_TARGET_KIND.LOCAL_PHASE
  ) {
    return DEV_LOOP_GATE.LOCAL_IMPLEMENTATION;
  }

  if (canonicalState.target.kind === DEV_LOOP_TARGET_KIND.ISSUE) {
    return DEV_LOOP_GATE.ISSUE_INTAKE;
  }

  // An explicit UI-review request intercepts a PR target ahead of the
  // ownership-derived PR gates: the running-app review is requested regardless
  // of who owns the PR. It stays after the authoritative lifecycle stop/terminal/
  // approval/waiting gates so it can never bypass them. Absent the signal this
  // branch is inert, so existing routes stay byte-identical.
  if (uiReviewRequested && canonicalState.target.kind === DEV_LOOP_TARGET_KIND.PR) {
    return DEV_LOOP_GATE.UI_REVIEW;
  }

  if (canonicalState.target.kind === DEV_LOOP_TARGET_KIND.PR && canonicalState.ownership === DEV_LOOP_ACTOR.EXTERNAL_HUMAN) {
    return DEV_LOOP_GATE.EXTERNAL_PR_FOLLOWUP;
  }

  if (
    canonicalState.target.kind === DEV_LOOP_TARGET_KIND.PR &&
    (canonicalState.ownership === DEV_LOOP_ACTOR.REVIEWER || canonicalState.nextActor === DEV_LOOP_ACTOR.REVIEWER)
  ) {
    return DEV_LOOP_GATE.REVIEWER_FIXER;
  }

  if (canonicalState.target.kind === DEV_LOOP_TARGET_KIND.PR && canonicalState.ownership === DEV_LOOP_ACTOR.COPILOT) {
    return DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP;
  }

  return DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE;
}

function isCopilotFirstIssueFlow(canonicalState) {
  return canonicalState.target.kind === DEV_LOOP_TARGET_KIND.ISSUE && canonicalState.ownership === DEV_LOOP_ACTOR.COPILOT;
}

function shouldAcceptIssueAssignmentFacts({ intent, explicitTarget, explicitState }) {
  if (explicitState) {
    return isCopilotFirstIssueFlow(explicitState) && explicitState.target.linkedPr === null;
  }

  return intent === DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE && explicitTarget?.kind === DEV_LOOP_TARGET_KIND.ISSUE;
}

function buildIssueClarificationStopNextAction(issueNumber) {
  return `Issue #${issueNumber} is not ready yet; ask focused clarification questions and stop before assigning ${COPILOT_ISSUE_ASSIGNEE}.`;
}

function buildIssueAssignmentNowNextAction(issueNumber) {
  return `Issue #${issueNumber} is ready and still unassigned; assign ${COPILOT_ISSUE_ASSIGNEE} now before PR/bootstrap/watch follow-up.`;
}

function buildIssueAssignedContinueNextAction(issueNumber) {
  return `Issue #${issueNumber} is ready and already assigned to ${COPILOT_ISSUE_ASSIGNEE}; continue into PR/bootstrap/watch follow-up work.`;
}

function resolveCopilotFirstIssueAssignmentSeam(canonicalState, issueReadiness, issueAssignmentState) {
  if (issueReadiness === DEV_LOOP_ISSUE_READINESS.NEEDS_CLARIFICATION) {
    return {
      issueAssignmentSeam: DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.NEEDS_REFINEMENT,
      routeKind: DEV_LOOP_ROUTE_KIND.STOP,
      nextAction: buildIssueClarificationStopNextAction(canonicalState.target.issue),
    };
  }

  if (issueAssignmentState === DEV_LOOP_ISSUE_ASSIGNMENT_STATE.ASSIGNED_TO_COPILOT) {
    return {
      issueAssignmentSeam: DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.ASSIGNED_TO_COPILOT,
      routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
      nextAction: buildIssueAssignedContinueNextAction(canonicalState.target.issue),
    };
  }

  if (canonicalState.authorization === DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION) {
    return {
      issueAssignmentSeam: DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.READY_NEEDS_ASSIGNMENT_CONFIRMATION,
      routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
      nextAction: buildIssueAssignmentConfirmationNextAction(canonicalState.target.issue),
    };
  }

  return {
    issueAssignmentSeam: DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.READY_ASSIGN_NOW,
    routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
    nextAction: buildIssueAssignmentNowNextAction(canonicalState.target.issue),
  };
}

function routeForState(
  canonicalState,
  {
    executionMode = DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
    issueReadiness = null,
    issueAssignmentState = null,
    gateReviewEvidence = null,
    targetPreference = null,
    uiReviewRequested = false,
  } = {},
) {
  const routableCanonicalState = toRoutableCanonicalState(canonicalState);
  const selectedGate = selectGateForState(routableCanonicalState, { uiReviewRequested });
  if (
    selectedGate === DEV_LOOP_GATE.FINAL_APPROVAL
    && routableCanonicalState.target.kind === DEV_LOOP_TARGET_KIND.PR
    && isFinalApprovalState(routableCanonicalState)
    && !hasCleanVisibleCurrentHeadPreApprovalGate(gateReviewEvidence)
  ) {
    return buildReconcile(
      "Final-approval routing requires explicit current-head `pre_approval_gate` evidence: (1) current head SHA identified, (2) a visible clean `pre_approval_gate` checkpoint verdict comment for that exact head SHA. CI green + resolved review threads + clean Copilot rereview are not sufficient substitutes. Do not suggest approval or merge without this proof; rerun the pre_approval_gate and confirm the checkpoint verdict comment before continuing.",
      routableCanonicalState,
      executionMode,
    );
  }

  if (selectedGate === DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED) {
    return buildResult({
      selectedGate,
      routeKind: DEV_LOOP_ROUTE_KIND.STOP,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
      executionMode,
      canonicalState: routableCanonicalState,
      nextAction: "Stop for a human decision or authorization before continuing the dev loop.",
      reason: "The canonical state is blocked or not authorized for an automated state change.",
    });
  }

  if (selectedGate === DEV_LOOP_GATE.STOP_DONE_TERMINAL) {
    return buildResult({
      selectedGate,
      routeKind: DEV_LOOP_ROUTE_KIND.STOP,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
      executionMode,
      canonicalState: routableCanonicalState,
      nextAction: "Report the terminal state and wait for a new work item.",
      reason: "The canonical state is already done.",
    });
  }

  if (selectedGate === DEV_LOOP_GATE.FINAL_APPROVAL) {
    const approvalNextAction = routableCanonicalState.status === DEV_LOOP_STATUS.APPROVAL_READY
      ? "Run only the final approval step for the current PR; do not treat approval as merge authorization."
      : "Merge is explicitly authorized for the current PR scope; run the final merge step.";
    const approvalReason = routableCanonicalState.status === DEV_LOOP_STATUS.APPROVAL_READY
      ? "Approval-ready states require an explicit approval decision before any merge authorization check."
      : "Merge-ready states with explicit merge authorization may proceed to merge.";
    return buildResult({
      selectedGate,
      routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL,
      executionMode,
      canonicalState: routableCanonicalState,
      nextAction: approvalNextAction,
      reason: approvalReason,
    });
  }

  if (selectedGate === DEV_LOOP_GATE.WAITING_FOR_MERGE_AUTHORIZATION) {
    return buildResult({
      selectedGate,
      routeKind: DEV_LOOP_ROUTE_KIND.STOP,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
      executionMode,
      canonicalState: routableCanonicalState,
      nextAction: "Formal approval is complete; wait for explicit merge authorization for this PR scope before merging. If authorization wording is ambiguous, ask for an explicit merge decision.",
      reason: "Merge-ready states must stop and wait when merge authorization is still missing.",
    });
  }

  if (selectedGate === DEV_LOOP_GATE.WAIT_WATCH) {
    const isDurableAuto = executionMode === DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO;
    return buildResult({
      selectedGate,
      routeKind: DEV_LOOP_ROUTE_KIND.WAIT,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH,
      executionMode,
      waitSemantics: isDurableAuto
        ? DEV_LOOP_WAIT_SEMANTICS.AUTO_HEALTHY_WAIT
        : DEV_LOOP_WAIT_SEMANTICS.DEFAULT,
      waitTimeoutPolicy: isDurableAuto
        ? EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY
        : PERSISTENT_INTERNAL_WAIT_TIMEOUT_POLICY,
      canonicalState: routableCanonicalState,
      nextAction: isDurableAuto
        ? "Remain in durable auto ownership while waiting on the same canonical state; do not escalate timeout/no-activity alone as attention."
        : "Keep waiting or watching against the same canonical state instead of switching public loop names.",
      reason: "Waiting states route to the shared wait/watch strategy.",
    });
  }

  if (selectedGate === DEV_LOOP_GATE.LOCAL_IMPLEMENTATION) {
    return buildResult({
      selectedGate,
      routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION,
      executionMode,
      canonicalState: routableCanonicalState,
      nextAction: "Run the local implementation strategy for the current branch or phase slice.",
      reason: "Local branch/phase targets stay on the local implementation strategy.",
    });
  }

  if (selectedGate === DEV_LOOP_GATE.ISSUE_INTAKE) {
    if (targetPreference === DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL) {
      const localPhase = routableCanonicalState.target.issue
        ? `issue-${routableCanonicalState.target.issue}`
        : null;
      const localTarget = {
        kind: DEV_LOOP_TARGET_KIND.LOCAL_PHASE,
        issue: routableCanonicalState.target.issue,
        pr: null,
        linkedPr: null,
        branch: null,
        phase: localPhase,
      };
      return buildResult({
        selectedGate: DEV_LOOP_GATE.LOCAL_IMPLEMENTATION,
        routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION,
        executionMode,
        canonicalState: { ...routableCanonicalState, target: localTarget },
        nextAction: `Run the local implementation strategy for issue #${routableCanonicalState.target.issue} (tracker-backed local session).`,
        reason: "Issue targets with `targetPreference=prefer_local` route to local implementation instead of Copilot-first issue intake.",
      });
    }
    const copilotFirstIssueSeam = isCopilotFirstIssueFlow(routableCanonicalState)
      ? resolveCopilotFirstIssueAssignmentSeam(routableCanonicalState, issueReadiness, issueAssignmentState)
      : {
          issueAssignmentSeam: DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.NOT_APPLICABLE,
          routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
          nextAction: "Normalize the issue, confirm scope, and determine whether an existing PR already exists.",
        };
    return buildResult({
      selectedGate,
      routeKind: copilotFirstIssueSeam.routeKind,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE,
      executionMode,
      canonicalState: routableCanonicalState,
      issueAssignmentSeam: copilotFirstIssueSeam.issueAssignmentSeam,
      nextAction: copilotFirstIssueSeam.nextAction,
      reason: "Issue targets without a linked PR route to issue intake before PR follow-up.",
    });
  }

  if (selectedGate === DEV_LOOP_GATE.EXTERNAL_PR_FOLLOWUP) {
    return buildResult({
      selectedGate,
      routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.EXTERNAL_PR_FOLLOWUP,
      executionMode,
      canonicalState: routableCanonicalState,
      nextAction: "Run the external-contributor PR follow-up strategy against the current PR state.",
      reason: "External-human PR ownership routes to the external PR follow-up strategy.",
    });
  }

  if (selectedGate === DEV_LOOP_GATE.REVIEWER_FIXER) {
    return buildResult({
      selectedGate,
      routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.REVIEWER_FIXER,
      executionMode,
      canonicalState: routableCanonicalState,
      nextAction: "Run the reviewer/fixer strategy for the current PR.",
      reason: "Reviewer-owned or reviewer-next PR states route to the reviewer/fixer strategy.",
    });
  }

  if (selectedGate === DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP) {
    return buildResult({
      selectedGate,
      routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP,
      executionMode,
      canonicalState: routableCanonicalState,
      nextAction: "Run the Copilot PR follow-up strategy for the current PR; treat it as the canonical artifact for the issue and do not open a second PR.",
      reason: "Copilot-owned PR states route to the Copilot PR follow-up strategy; an already-open linked PR must stay canonical until reconciled.",
    });
  }

  if (selectedGate === DEV_LOOP_GATE.UI_REVIEW) {
    return buildResult({
      selectedGate,
      routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
      selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW,
      executionMode,
      canonicalState: routableCanonicalState,
      nextAction: "Run the UI-review route for the current PR: prove the change in the running app from an isolated worktree. Do not write product code; keep any outward review pending/draft; acknowledge destructive migrations before running them.",
      reason: "An explicit UI-review request on a PR target routes to the ui_review strategy — the running-app review sibling of the reviewer/fixer route.",
    });
  }

  return buildReconcile(
    "The canonical current state does not map cleanly to any first-slice internal strategy.",
    routableCanonicalState,
    executionMode,
  );
}

function buildStatusArtifactIdentity(canonicalState) {
  return {
    kind: canonicalState.target.kind,
    issue: canonicalState.target.issue,
    pr: canonicalState.target.pr,
    branch: canonicalState.target.branch,
    phase: canonicalState.target.phase,
  };
}

function buildIssueAssignmentConfirmationNextAction(issueNumber) {
  return `Authorize the next mutation: assign ${COPILOT_ISSUE_ASSIGNEE} to issue #${issueNumber} now?`;
}

function buildAuthoritativeStatusNextAction(routed) {
  return routed?.nextAction ?? "Reconcile the current state before answering status.";
}

function buildStartupResumeBundleReconcile({
  reason,
  canonicalState = null,
  issueLinkageResolution = null,
  artifactState = null,
  loopState = null,
  nextAction = "Stop and reconcile the authoritative startup/resume state before routing or answering status.",
  executionMode = DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
  waitSemantics = DEV_LOOP_WAIT_SEMANTICS.DEFAULT,
  waitTimeoutPolicy = null,
  asyncRun = null,
}) {
  const result = {
    bundleKind: DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE,
    reason,
    activeArtifact: canonicalState ? buildStatusArtifactIdentity(canonicalState) : null,
    artifactState,
    issueLinkageResolution,
    loopState: "unknown",
    nextAction,
    selectedGate: DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE,
    routeKind: DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
    executionMode,
    waitSemantics,
    waitTimeoutPolicy,
    asyncRun,
    canonicalState,
  };
  return {
    ...result,
    contractTrace: buildContractTrace({
      selectedGate: result.selectedGate,
      routeKind: result.routeKind,
      selectedStrategy: result.selectedStrategy,
      executionMode,
      waitSemantics,
      waitTimeoutPolicy,
      canonicalState,
      reason,
      boundary: {
        boundaryKind: "startup_resume_refresh",
        refreshRequired: true,
        refreshReason: "Startup/resume routing must record the refreshed authoritative state boundary that justified this stop or reconcile decision.",
        ...(loopState !== null ? { loopState } : {}),
        ...(artifactState !== null ? { artifactState } : {}),
        ...(issueLinkageResolution !== null ? { issueLinkageResolution } : {}),
      },
    }),
  };
}

function normalizeIssueLinkageResolutionForBundle(canonicalState, issueLinkageResolution) {
  if (issueLinkageResolution) {
    return issueLinkageResolution;
  }

  if (canonicalState?.target?.kind !== DEV_LOOP_TARGET_KIND.ISSUE) {
    return DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE;
  }

  return null;
}

function applyInitialCopilotBootstrapRefreshSeam(canonicalState, issueLinkageResolution, loopState) {
  if (loopState === PRIOR_LINKED_PR_CLOSED_UNMERGED_LOOP_STATE) {
    if (
      canonicalState.target.kind !== DEV_LOOP_TARGET_KIND.ISSUE
      || canonicalState.target.linkedPr !== null
      || issueLinkageResolution !== DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR
      || canonicalState.ownership !== DEV_LOOP_ACTOR.COPILOT
    ) {
      return {
        canonicalState,
        reason:
          "Refreshed `prior_linked_pr_closed_unmerged` state conflicts with authoritative no-open-linked-PR Copilot issue facts; reconcile before routing startup/resume state.",
      };
    }

    return {
      canonicalState,
      reason:
        "Refreshed bootstrap state reports a prior linked PR closed unmerged; reconcile the issue instead of treating it as a healthy bootstrap wait or fresh issue-intake path.",
    };
  }

  if (loopState !== LINKED_PR_READY_FOR_FOLLOWUP_LOOP_STATE) {
    return { canonicalState, reason: null };
  }

  if (canonicalState.target.kind === DEV_LOOP_TARGET_KIND.PR) {
    return { canonicalState, reason: null };
  }

  if (canonicalState.target.kind !== DEV_LOOP_TARGET_KIND.ISSUE) {
    return {
      canonicalState,
      reason:
        "Refreshed `linked_pr_ready_for_followup` state requires a linked PR canonical target; reconcile before routing startup/resume state.",
    };
  }

  if (
    issueLinkageResolution !== DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_LINKED_PR
    || canonicalState.target.linkedPr === null
    || canonicalState.ownership !== DEV_LOOP_ACTOR.COPILOT
  ) {
    return {
      canonicalState,
      reason:
        "Refreshed `linked_pr_ready_for_followup` state conflicts with authoritative linked PR follow-up facts; reconcile before routing startup/resume state.",
    };
  }

  return {
    canonicalState: {
      ...canonicalState,
      target: {
        kind: DEV_LOOP_TARGET_KIND.PR,
        issue: canonicalState.target.issue,
        pr: canonicalState.target.linkedPr,
        linkedPr: null,
        branch: null,
        phase: null,
      },
      status: DEV_LOOP_STATUS.ACTIVE,
    },
    reason: null,
  };
}

function isArtifactStateCompatible(canonicalState, artifactState) {
  if (canonicalState.target.kind !== DEV_LOOP_TARGET_KIND.PR) {
    return artifactState === DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE;
  }

  if (canonicalState.status === DEV_LOOP_STATUS.DONE) {
    return artifactState === DEV_LOOP_ARTIFACT_STATE.CLOSED || artifactState === DEV_LOOP_ARTIFACT_STATE.MERGED;
  }

  return artifactState === DEV_LOOP_ARTIFACT_STATE.OPEN;
}

function validateIssueLinkageResolution(canonicalState, issueLinkageResolution) {
  if (canonicalState.target.kind !== DEV_LOOP_TARGET_KIND.ISSUE) {
    return issueLinkageResolution === null
      || issueLinkageResolution === DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE;
  }

  if (canonicalState.target.linkedPr !== null) {
    return issueLinkageResolution === DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_LINKED_PR;
  }

  return issueLinkageResolution === DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR;
}

function synthesizeCanonicalStateFromShorthand(input, intent) {
  if (intent === null) return null;
  const explicitIssue = Number.isInteger(input.issue) && input.issue > 0 ? input.issue : null;
  if (explicitIssue === null) return null;
  const ISSUE_LOCAL_INTENTS = new Set([
    DEV_LOOP_PUBLIC_INTENT.START_ISSUE_LOCALLY,
    DEV_LOOP_PUBLIC_INTENT.START_ISSUE_LOCALLY_THEN_CONTINUE,
  ]);
  if (ISSUE_LOCAL_INTENTS.has(intent)) {
    const phase = `issue-${explicitIssue}`;
    return {
      target: { kind: DEV_LOOP_TARGET_KIND.LOCAL_PHASE, issue: explicitIssue, pr: null, linkedPr: null, branch: null, phase },
      ownership: DEV_LOOP_ACTOR.LOCAL,
      nextActor: DEV_LOOP_ACTOR.LOCAL,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    };
  }
  if (intent === DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE) {
    return {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: explicitIssue, pr: null, linkedPr: null, branch: null, phase: null },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.USER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    };
  }
  return null;
}


export function resolveAuthoritativeStartupResumeBundle(input = {}) {
  let canonicalState = normalizeState(input.currentState);
  const intent = normalizeIntent(input.intent);
  if (!canonicalState) {
    canonicalState = synthesizeCanonicalStateFromShorthand(input, intent);
  }
  const variationMode = input.mode !== undefined ? normalizeVariationMode(input.mode) : null;
  const requestedExecutionMode =
    variationMode
    ?? (intent === DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT
      ? DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO
      : DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF);
  if (!canonicalState) {
    return buildStartupResumeBundleReconcile({
      reason: "Authoritative startup/resume routing requires a valid canonical current state.",
      executionMode: requestedExecutionMode,
    });
  }

  if (input.intent !== undefined && intent === null) {
    return buildStartupResumeBundleReconcile({
      reason: "Authoritative startup/resume routing received an invalid public dev-loop intent.",
      canonicalState,
      executionMode: requestedExecutionMode,
    });
  }

  if (input.mode !== undefined && variationMode === null) {
    return buildStartupResumeBundleReconcile({
      reason: `Authoritative startup/resume routing received an invalid execution mode value; allowed values: ${ALLOWED_MODE_VALUES_TEXT}.`,
      canonicalState,
      executionMode: requestedExecutionMode,
    });
  }

  if (
    intent === DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT
    && variationMode === DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF
  ) {
    return buildStartupResumeBundleReconcile({
      reason: "`mode=bounded_handoff` conflicts with the `auto_continue_current` intent; `auto_continue_current` always uses durable auto execution mode.",
      canonicalState,
      executionMode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    });
  }

  const effectiveMode = intent === DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT
    ? DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO
    : (variationMode ?? DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF);

  const targetPreference = input.targetPreference !== undefined
    ? normalizeTargetPreference(input.targetPreference)
    : null;

  if (input.targetPreference !== undefined && targetPreference === null) {
    return buildStartupResumeBundleReconcile({
      reason: `Authoritative startup/resume routing received an invalid targetPreference value; allowed values: ${ALLOWED_TARGET_PREFERENCE_VALUES_TEXT}.`,
      canonicalState,
      executionMode: effectiveMode,
    });
  }

  const issueLinkageResolution = normalizeIssueLinkageResolution(input.issueLinkageResolution);
  const issueReadiness = normalizeIssueReadiness(input.issueReadiness);
  const issueAssignmentState = normalizeIssueAssignmentState(input.issueAssignmentState);
  const gateReviewEvidence = normalizeGateReviewEvidence(input.gateReviewEvidence);
  const asyncRunProvided = input.asyncRun !== undefined && input.asyncRun !== null;
  const asyncRun = asyncRunProvided ? normalizeAsyncRun(input.asyncRun) : null;
  const retrospectiveCheckpointState = input.retrospectiveCheckpointState !== undefined
    ? normalizeRetrospectiveCheckpointState(input.retrospectiveCheckpointState)
    : null;
  const retrospectiveCheckpointStateProvided =
    input.retrospectiveCheckpointState !== undefined && input.retrospectiveCheckpointState !== null;
  const issueLinkageResolutionProvided = input.issueLinkageResolution !== undefined && input.issueLinkageResolution !== null;
  const normalizedIssueLinkageResolution = normalizeIssueLinkageResolutionForBundle(canonicalState, issueLinkageResolution);
  const issueReadinessProvided = input.issueReadiness !== undefined && input.issueReadiness !== null;
  const issueAssignmentStateProvided = input.issueAssignmentState !== undefined && input.issueAssignmentState !== null;
  const loopState = normalizeOptionalLoopState(input.loopState);

  if (asyncRunProvided && asyncRun === null) {
    return buildStartupResumeBundleReconcile({
      reason: "Authoritative startup/resume routing received an invalid async-run registration value.",
      canonicalState,
      executionMode: effectiveMode,
    });
  }

  if (issueLinkageResolutionProvided && issueLinkageResolution === null) {
    return buildStartupResumeBundleReconcile({
      reason: "Authoritative startup/resume routing received an invalid issue↔PR linkage resolution value.",
      canonicalState,
      issueLinkageResolution: null,
    });
  }

  if (issueReadinessProvided && issueReadiness === null) {
    return buildStartupResumeBundleReconcile({
      reason: "Authoritative startup/resume routing received an invalid issue readiness value.",
      canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
    });
  }

  if (issueAssignmentStateProvided && issueAssignmentState === null) {
    return buildStartupResumeBundleReconcile({
      reason: "Authoritative startup/resume routing received an invalid issue assignment-state value.",
      canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
    });
  }

  if (retrospectiveCheckpointStateProvided && retrospectiveCheckpointState === null) {
    return buildStartupResumeBundleReconcile({
      reason: "Authoritative startup/resume routing received an invalid retrospective checkpoint-state value.",
      canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
    });
  }

  if (loopState === null) {
    return buildStartupResumeBundleReconcile({
      reason: "Authoritative startup/resume routing requires an explicit resolved loop state before routing or answering status.",
      canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
      artifactState: normalizeArtifactState(input.artifactState),
      loopState,
    });
  }

  const bootstrapRefresh = applyInitialCopilotBootstrapRefreshSeam(
    canonicalState,
    issueLinkageResolution,
    loopState,
  );
  if (bootstrapRefresh.reason !== null) {
    return buildStartupResumeBundleReconcile({
      reason: bootstrapRefresh.reason,
      canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
      artifactState: normalizeArtifactState(input.artifactState),
      loopState,
    });
  }
  const canonicalStateForRouting = bootstrapRefresh.canonicalState;

  if (
    canonicalState.target.kind === DEV_LOOP_TARGET_KIND.ISSUE
    && issueLinkageResolution === null
  ) {
    return buildStartupResumeBundleReconcile({
      reason: "Issue targets require explicit authoritative issue↔PR linkage resolution before routing startup/resume state.",
      canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
      loopState,
    });
  }

  if (!validateIssueLinkageResolution(canonicalState, issueLinkageResolution)) {
    return buildStartupResumeBundleReconcile({
      reason: "Issue↔PR linkage resolution is incomplete or conflicts with canonical current state; reconcile before routing startup/resume state.",
      canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
      loopState,
    });
  }

  if (
    canonicalState.target.kind === DEV_LOOP_TARGET_KIND.ISSUE
    && canonicalState.ownership === DEV_LOOP_ACTOR.COPILOT
    && issueLinkageResolution === DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR
  ) {
    if (!issueReadinessProvided) {
      return buildStartupResumeBundleReconcile({
        reason: "Copilot-first issue targets require explicit authoritative issue readiness before assignment/routing decisions.",
        canonicalState,
        issueLinkageResolution: normalizedIssueLinkageResolution,
        loopState,
      });
    }

    if (!issueAssignmentStateProvided) {
      return buildStartupResumeBundleReconcile({
        reason: "Copilot-first issue targets require explicit authoritative issue assignment state before assignment/routing decisions.",
        canonicalState,
        issueLinkageResolution: normalizedIssueLinkageResolution,
        loopState,
      });
    }
  }

  const routed = routeForState(canonicalStateForRouting, {
    executionMode: effectiveMode,
    issueReadiness,
    issueAssignmentState,
    gateReviewEvidence,
    targetPreference,
    uiReviewRequested: intent === DEV_LOOP_PUBLIC_INTENT.REVIEW_PR_UI,
  });
  if (routed.routeKind === DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE) {
    return buildStartupResumeBundleReconcile({
      reason: routed.reason,
      canonicalState: routed.canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
      executionMode: routed.executionMode,
      waitSemantics: routed.waitSemantics,
      loopState,
    });
  }

  const artifactState = normalizeArtifactState(input.artifactState);
  if (!artifactState) {
    return buildStartupResumeBundleReconcile({
      reason: "Authoritative startup/resume routing requires an explicit artifact state (open|closed|merged|not_applicable).",
      canonicalState: routed.canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
      artifactState: null,
      loopState,
    });
  }

  if (!isArtifactStateCompatible(routed.canonicalState, artifactState)) {
    return buildStartupResumeBundleReconcile({
      reason: "Canonical current state conflicts with the provided artifact state; reconcile before routing startup/resume state.",
      canonicalState: routed.canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
      artifactState,
      loopState,
    });
  }

  const inspectStateIntent = intent === DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE;
  const routedWithIntentSemantics = inspectStateIntent
    ? {
        ...routed,
        routeKind: DEV_LOOP_ROUTE_KIND.INSPECT,
        nextAction: "Describe the canonical state and the routed internal strategy without changing public entrypoints.",
      }
    : routed;
  const effectiveRouted = applyRetrospectiveCheckpointGate(
    routedWithIntentSemantics,
    retrospectiveCheckpointState,
    retrospectiveCheckpointStateProvided,
  );

  if (effectiveRouted.routeKind === DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE) {
    return buildStartupResumeBundleReconcile({
      reason: effectiveRouted.reason,
      canonicalState: effectiveRouted.canonicalState ?? routed.canonicalState,
      issueLinkageResolution: normalizedIssueLinkageResolution,
      artifactState,
      nextAction: effectiveRouted.nextAction,
      executionMode: effectiveRouted.executionMode,
      waitSemantics: effectiveRouted.waitSemantics,
      waitTimeoutPolicy: effectiveRouted.waitTimeoutPolicy,
      asyncRun,
      loopState,
    });
  }

  if (effectiveRouted.executionMode === DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO) {
    const asyncRunInspectionState = asyncRun?.inspectionState;
    if (
      !asyncRunProvided
      || asyncRun?.kind !== "pi_managed_run"
      || asyncRun.runId === null
      || asyncRun.visible !== true
      || asyncRunInspectionState === "uninspectable"
      || asyncRunInspectionState === "hidden"
      || asyncRunInspectionState === "stale"
    ) {
      return buildStartupResumeBundleReconcile({
        reason: asyncRun?.kind === "detached_process"
          ? "Durable auto startup/resume requires a visible Pi-managed async run; detached local background processes do not satisfy the async-start contract."
          : asyncRunInspectionState === "uninspectable"
            ? "Durable auto startup/resume requires inspectable Pi-managed async evidence; observed run is uninspectable (no child message route registered)."
            : asyncRunInspectionState === "hidden"
              ? "Durable auto startup/resume requires visible Pi-managed async evidence; observed run evidence is hidden."
              : asyncRunInspectionState === "stale"
                ? "Durable auto startup/resume requires fresh Pi-managed async evidence; observed run evidence is stale."
          : "Durable auto startup/resume requires a visible registered Pi-managed async run id before startup can be reported as successful.",
        canonicalState: effectiveRouted.canonicalState,
        issueLinkageResolution: normalizedIssueLinkageResolution,
        artifactState,
        executionMode: effectiveRouted.executionMode,
        waitSemantics: effectiveRouted.waitSemantics,
        waitTimeoutPolicy: effectiveRouted.waitTimeoutPolicy,
        asyncRun,
      });
    }
  }

  return {
    bundleKind: DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED,
    activeArtifact: buildStatusArtifactIdentity(effectiveRouted.canonicalState),
    artifactState,
    issueLinkageResolution: normalizedIssueLinkageResolution,
    canonicalState: effectiveRouted.canonicalState,
    loopState,
    routeKind: effectiveRouted.routeKind,
    selectedGate: effectiveRouted.selectedGate,
    selectedStrategy: effectiveRouted.selectedStrategy,
    executionMode: effectiveRouted.executionMode,
    waitSemantics: effectiveRouted.waitSemantics,
    waitTimeoutPolicy: effectiveRouted.waitTimeoutPolicy,
    asyncRun: effectiveRouted.executionMode === DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO ? asyncRun : null,
    issueAssignmentSeam: effectiveRouted.issueAssignmentSeam,
    nextAction: buildAuthoritativeStatusNextAction(effectiveRouted),
    reason: effectiveRouted.reason,
    contractTrace: buildContractTrace({
      selectedGate: effectiveRouted.selectedGate,
      routeKind: effectiveRouted.routeKind,
      selectedStrategy: effectiveRouted.selectedStrategy,
      executionMode: effectiveRouted.executionMode,
      waitSemantics: effectiveRouted.waitSemantics,
      waitTimeoutPolicy: effectiveRouted.waitTimeoutPolicy,
      canonicalState: effectiveRouted.canonicalState,
      reason: effectiveRouted.reason,
      boundary: {
        boundaryKind: "startup_resume_refresh",
        refreshRequired: true,
        refreshReason: "Startup/resume answers record the authoritative refreshed loop state that justified the routed path.",
        loopState,
        artifactState,
        issueLinkageResolution: normalizedIssueLinkageResolution,
      },
    }),
  };
}


const BUILT_IN_DEFAULT_TARGET_PREFERENCE = DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL;

// DEFAULT_TARGET_PREFERENCE uses the built-in default (local-first).
// Config-based target preference is resolved by the startup resolver
// (resolveTargetPreference in scripts/loop/resolve-dev-loop-startup.mjs)
// and passed explicitly via input.targetPreference.
// This module must not read the live config file at import time
// because test suites run from the repo root and would pick up the
// repo's own .devloops, making tests depend on live config.
const DEFAULT_TARGET_PREFERENCE = BUILT_IN_DEFAULT_TARGET_PREFERENCE;

function buildStatusReconcile(
  reason,
  canonicalState = null,
  nextAction = "Stop and reconcile the authoritative active artifact and current loop state before answering status.",
  executionMode = DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
  waitSemantics = DEV_LOOP_WAIT_SEMANTICS.DEFAULT,
  waitTimeoutPolicy = null,
  asyncRun = null,
  { artifactState = null, loopState = null, issueLinkageResolution = null } = {},
) {
  const result = {
    statusKind: DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE,
    reason,
    activeArtifact: canonicalState ? buildStatusArtifactIdentity(canonicalState) : null,
    artifactState: null,
    loopState: "unknown",
    nextAction,
    selectedGate: DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE,
    routeKind: DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
    executionMode,
    waitSemantics,
    waitTimeoutPolicy,
    asyncRun,
    canonicalState,
  };
  return {
    ...result,
    contractTrace: buildContractTrace({
      selectedGate: result.selectedGate,
      routeKind: result.routeKind,
      selectedStrategy: result.selectedStrategy,
      executionMode,
      waitSemantics,
      waitTimeoutPolicy,
      canonicalState,
      reason,
      boundary: {
        boundaryKind: "authoritative_status_refresh",
        refreshRequired: true,
        refreshReason: "Status answers are derived from refreshed authoritative state and must fail closed when that refresh cannot justify the stop classification.",
        ...(loopState !== null ? { loopState } : {}),
        ...(artifactState !== null ? { artifactState } : {}),
        ...(issueLinkageResolution !== null ? { issueLinkageResolution } : {}),
      },
    }),
  };
}

export function resolveAuthoritativeDevLoopStatus(input = {}) {
  const { intent: _ignoredIntent, ...statusInput } = input;
  const bundle = resolveAuthoritativeStartupResumeBundle(statusInput);
  if (bundle.bundleKind === DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE) {
    return buildStatusReconcile(
      bundle.reason,
      bundle.canonicalState,
      bundle.nextAction,
      bundle.executionMode,
      bundle.waitSemantics,
      bundle.waitTimeoutPolicy,
      bundle.asyncRun,
      {
        artifactState: bundle.contractTrace?.stateRefresh?.artifactState ?? bundle.artifactState,
        loopState: bundle.contractTrace?.stateRefresh?.loopState ?? bundle.loopState,
        issueLinkageResolution: bundle.contractTrace?.stateRefresh?.issueLinkageResolution ?? bundle.issueLinkageResolution,
      },
    );
  }

  const result = {
    statusKind: DEV_LOOP_STATUS_REPORT_KIND.RESOLVED,
    activeArtifact: bundle.activeArtifact,
    artifactState: bundle.artifactState,
    loopState: bundle.loopState,
    nextAction: bundle.nextAction,
    selectedGate: bundle.selectedGate,
    routeKind: bundle.routeKind,
    selectedStrategy: bundle.selectedStrategy,
    executionMode: bundle.executionMode,
    waitSemantics: bundle.waitSemantics,
    waitTimeoutPolicy: bundle.waitTimeoutPolicy,
    asyncRun: bundle.asyncRun,
    issueAssignmentSeam: bundle.issueAssignmentSeam,
    canonicalState: bundle.canonicalState,
    reason: bundle.reason,
  };

  return {
    ...result,
    contractTrace: buildContractTrace({
      selectedGate: result.selectedGate,
      routeKind: result.routeKind,
      selectedStrategy: result.selectedStrategy,
      executionMode: result.executionMode,
      waitSemantics: result.waitSemantics,
      waitTimeoutPolicy: result.waitTimeoutPolicy,
      canonicalState: result.canonicalState,
      reason: result.reason,
      boundary: {
        boundaryKind: "authoritative_status_refresh",
        refreshRequired: true,
        refreshReason: "Status answers record the authoritative refreshed loop state that justified the reported state.",
        loopState: result.loopState,
        artifactState: result.artifactState,
        issueLinkageResolution: bundle.issueLinkageResolution,
      },
    }),
  };
}

export function evaluatePublicDevLoopRouting(input = {}) {
  const intent = normalizeIntent(input.intent);
  const explicitTarget = normalizeTarget(input.target);
  const explicitState = normalizeState(input.currentState);

  // ── Variation parameters (first-slice bounded contract) ──────────────────
  const variationMode = input.mode !== undefined ? normalizeVariationMode(input.mode) : null;
  const watchProvided = input.watch !== undefined;
  const watchRequested = input.watch === true;
  const targetPreference = input.targetPreference !== undefined
    ? normalizeTargetPreference(input.targetPreference)
    : DEFAULT_TARGET_PREFERENCE;

  // These are authoritative issue-state facts for the Copilot-first
  // unassigned-issue seam, not bounded public variation parameters.
  const issueReadiness = input.issueReadiness !== undefined ? normalizeIssueReadiness(input.issueReadiness) : null;
  const issueAssignmentState = input.issueAssignmentState !== undefined
    ? normalizeIssueAssignmentState(input.issueAssignmentState)
    : null;
  const gateReviewEvidence = normalizeGateReviewEvidence(input.gateReviewEvidence);
  const acceptsIssueAssignmentFacts = shouldAcceptIssueAssignmentFacts({ intent, explicitTarget, explicitState });
  const retrospectiveCheckpointState = input.retrospectiveCheckpointState !== undefined
    ? normalizeRetrospectiveCheckpointState(input.retrospectiveCheckpointState)
    : null;
  const retrospectiveCheckpointStateProvided =
    input.retrospectiveCheckpointState !== undefined && input.retrospectiveCheckpointState !== null;
  const requestedExecutionMode =
    variationMode
    ?? (intent === DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT
      ? DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO
      : DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF);
  const buildInputReconcile = (reason, canonicalState = null, executionMode = requestedExecutionMode) => buildReconcile(
    reason,
    canonicalState,
    executionMode,
    { watchRequested },
  );

  // Fail closed on unrecognized variation parameter values
  if (input.mode !== undefined && variationMode === null) {
    return buildInputReconcile(`Unrecognized \`mode\` parameter; allowed values: ${ALLOWED_MODE_VALUES_TEXT}.`, null, requestedExecutionMode);
  }
  if (input.targetPreference !== undefined && targetPreference === null) {
    return buildInputReconcile(`Unrecognized \`targetPreference\` parameter; allowed values: ${ALLOWED_TARGET_PREFERENCE_VALUES_TEXT}.`, null, requestedExecutionMode);
  }
  if (watchProvided && typeof input.watch !== "boolean") {
    return buildInputReconcile("Unrecognized `watch` parameter; allowed values: true or false.", null, requestedExecutionMode);
  }
  if (acceptsIssueAssignmentFacts && input.issueReadiness !== undefined && issueReadiness === null) {
    return buildInputReconcile(
      `Unrecognized \`issueReadiness\` input; allowed values: ${Object.values(DEV_LOOP_ISSUE_READINESS).join(", ")}.`,
      null,
      requestedExecutionMode,
    );
  }
  if (acceptsIssueAssignmentFacts && input.issueAssignmentState !== undefined && issueAssignmentState === null) {
    return buildInputReconcile(
      `Unrecognized \`issueAssignmentState\` input; allowed values: ${Object.values(DEV_LOOP_ISSUE_ASSIGNMENT_STATE).join(", ")}.`,
      null,
      requestedExecutionMode,
    );
  }

  if (retrospectiveCheckpointStateProvided && retrospectiveCheckpointState === null) {
    return buildInputReconcile(
      "Unrecognized `retrospectiveCheckpointState` input; allowed values: none, complete, skipped, missing.",
      null,
      requestedExecutionMode,
    );
  }

  const routingOptions = {
    executionMode: null,
    issueReadiness: acceptsIssueAssignmentFacts ? issueReadiness : null,
    issueAssignmentState: acceptsIssueAssignmentFacts ? issueAssignmentState : null,
    gateReviewEvidence,
    targetPreference,
  };

  const finalizeRoutingResult = (result) => {
    const gated = applyRetrospectiveCheckpointGate(
      result,
      retrospectiveCheckpointState,
      retrospectiveCheckpointStateProvided,
    );

    return withContractTrace(gated, {
      watchRequested,
      boundary: gated.contractTrace?.stateRefresh ?? result.contractTrace?.stateRefresh ?? null,
    });
  };

  if (!intent) {
    return buildInputReconcile("The public dev-loop intent is missing or unrecognized.", null, requestedExecutionMode);
  }

  // ── Resolve effective execution mode ─────────────────────────────────────
  // Precedence: authoritative intent (auto_continue_current) > explicit mode > default
  let effectiveMode;
  if (intent === DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT) {
    if (variationMode === DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF) {
      return buildInputReconcile(
        "`mode=bounded_handoff` conflicts with the `auto_continue_current` intent; `auto_continue_current` always uses durable auto execution mode.",
        explicitState,
        DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
      );
    }
    effectiveMode = DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO;
  } else {
    effectiveMode = variationMode ?? DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF;
  }

  if (variationMode === DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO && !explicitState) {
    return buildInputReconcile(
      "`mode=durable_auto` requires a valid authoritative current state.",
      null,
      DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (intent === DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE) {
    if (!explicitState) {
      return buildInputReconcile("`inspect_state` requires a valid canonical current state.", null, effectiveMode);
    }

    const routed = routeForState(explicitState, { ...routingOptions, executionMode: effectiveMode });
    return finalizeRoutingResult(applyWatchValidation({
      ...routed,
      routeKind: DEV_LOOP_ROUTE_KIND.INSPECT,
      nextAction: "Describe the canonical state and the routed internal strategy without changing public entrypoints.",
    }, watchRequested));
  }

  if (intent === DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE) {
    if (!explicitTarget || explicitTarget.kind !== DEV_LOOP_TARGET_KIND.ISSUE) {
      return buildInputReconcile("`start_on_issue` requires an issue target.", null, effectiveMode);
    }

    if (input.currentState !== undefined && !explicitState) {
      return buildInputReconcile("`start_on_issue` received an invalid canonical current state.", null, effectiveMode);
    }

    if (explicitState) {
      if (explicitState.target.issue !== explicitTarget.issue) {
        return buildInputReconcile("`start_on_issue` target conflicts with the canonical current state.", explicitState, effectiveMode);
      }

      // targetPreference=prefer_local must not override authoritative linked-PR or PR state
      if (targetPreference === DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL) {
        const isLinkedPrState =
          explicitState.target.kind === DEV_LOOP_TARGET_KIND.PR ||
          (explicitState.target.kind === DEV_LOOP_TARGET_KIND.ISSUE && explicitState.target.linkedPr !== null);
        if (isLinkedPrState) {
          return buildInputReconcile(
            "`targetPreference=prefer_local` conflicts with authoritative PR/linked-PR active artifact state; reconcile before overriding the routed path.",
            explicitState,
            effectiveMode,
          );
        }
      }

      return finalizeRoutingResult(applyWatchValidation(
        routeForState(explicitState, { ...routingOptions, executionMode: effectiveMode }),
        watchRequested,
      ));
    }

    // No canonical state: steer toward local when prefer_local is requested
    if (targetPreference === DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL) {
      return finalizeRoutingResult(applyWatchValidation(
        routeForState({
          target: {
            kind: DEV_LOOP_TARGET_KIND.LOCAL_PHASE,
            issue: explicitTarget.issue,
            pr: null,
            linkedPr: null,
            branch: null,
            phase: `issue-${explicitTarget.issue}`,
          },
          ownership: DEV_LOOP_ACTOR.LOCAL,
          nextActor: DEV_LOOP_ACTOR.LOCAL,
          status: DEV_LOOP_STATUS.ACTIVE,
          authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
        }, { ...routingOptions, executionMode: effectiveMode }),
        watchRequested,
      ));
    }

    return finalizeRoutingResult(applyWatchValidation(
      routeForState({
        target: explicitTarget,
        ownership: DEV_LOOP_ACTOR.COPILOT,
        nextActor: DEV_LOOP_ACTOR.USER,
        status: DEV_LOOP_STATUS.ACTIVE,
        authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
      }, { ...routingOptions, executionMode: effectiveMode }),
      watchRequested,
    ));
  }

  if (
    intent === DEV_LOOP_PUBLIC_INTENT.START_ISSUE_LOCALLY ||
    intent === DEV_LOOP_PUBLIC_INTENT.START_ISSUE_LOCALLY_THEN_CONTINUE
  ) {
    if (!explicitTarget || explicitTarget.kind !== DEV_LOOP_TARGET_KIND.ISSUE) {
      return buildInputReconcile("Local issue-start intents require an issue target.", null, effectiveMode);
    }

    if (input.currentState !== undefined && !explicitState) {
      return buildInputReconcile("Local issue-start intents received an invalid canonical current state.", null, effectiveMode);
    }

    if (explicitState) {
      if (
        explicitState.target.kind !== DEV_LOOP_TARGET_KIND.LOCAL_PHASE ||
        explicitState.target.issue !== explicitTarget.issue
      ) {
        return buildInputReconcile("Local issue-start target conflicts with the canonical current state.", explicitState, effectiveMode);
      }
      return finalizeRoutingResult(applyWatchValidation(
        routeForState(explicitState, { ...routingOptions, executionMode: effectiveMode }),
        watchRequested,
      ));
    }

    const routed = routeForState({
      target: {
        kind: DEV_LOOP_TARGET_KIND.LOCAL_PHASE,
        issue: explicitTarget.issue,
        pr: null,
        linkedPr: null,
        branch: null,
        phase: `issue-${explicitTarget.issue}`,
      },
      ownership: DEV_LOOP_ACTOR.LOCAL,
      nextActor: DEV_LOOP_ACTOR.LOCAL,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    }, { ...routingOptions, executionMode: effectiveMode });

    const routedWithContinueAction = intent === DEV_LOOP_PUBLIC_INTENT.START_ISSUE_LOCALLY_THEN_CONTINUE
      ? {
          ...routed,
          nextAction:
            "Start with the local implementation strategy now, then re-enter the same public `dev-loop` entrypoint against the updated canonical state.",
        }
      : routed;

    return finalizeRoutingResult(applyWatchValidation(routedWithContinueAction, watchRequested));
  }

  if (intent === DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR) {
    if (!explicitTarget || explicitTarget.kind !== DEV_LOOP_TARGET_KIND.PR) {
      return buildInputReconcile("`continue_on_pr` requires a PR target.", null, effectiveMode);
    }
    if (!explicitState || explicitState.target.kind !== DEV_LOOP_TARGET_KIND.PR) {
      return buildInputReconcile("`continue_on_pr` requires a valid canonical PR state.", explicitState, effectiveMode);
    }
    if (explicitState.target.pr !== explicitTarget.pr) {
      return buildInputReconcile("`continue_on_pr` target conflicts with the canonical current PR state.", explicitState, effectiveMode);
    }

    // targetPreference=prefer_local must not override an active PR artifact
    if (targetPreference === DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL) {
      return buildInputReconcile(
        "`targetPreference=prefer_local` conflicts with authoritative PR/linked-PR active artifact state; reconcile before overriding the routed path.",
        explicitState,
        effectiveMode,
      );
    }

    return finalizeRoutingResult(applyWatchValidation(
      routeForState(explicitState, { ...routingOptions, executionMode: effectiveMode }),
      watchRequested,
    ));
  }

  if (intent === DEV_LOOP_PUBLIC_INTENT.REVIEW_PR_UI) {
    if (!explicitTarget || explicitTarget.kind !== DEV_LOOP_TARGET_KIND.PR) {
      return buildInputReconcile("`review_pr_ui` requires a PR target.", null, effectiveMode);
    }
    if (!explicitState || explicitState.target.kind !== DEV_LOOP_TARGET_KIND.PR) {
      return buildInputReconcile("`review_pr_ui` requires a valid canonical PR state.", explicitState, effectiveMode);
    }
    if (explicitState.target.pr !== explicitTarget.pr) {
      return buildInputReconcile("`review_pr_ui` target conflicts with the canonical current PR state.", explicitState, effectiveMode);
    }

    return finalizeRoutingResult(applyWatchValidation(
      routeForState(explicitState, { ...routingOptions, executionMode: effectiveMode, uiReviewRequested: true }),
      watchRequested,
    ));
  }

  if (intent === DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT) {
    if (!explicitState) {
      return buildInputReconcile("`continue_current` requires a valid canonical current state.", null, effectiveMode);
    }

    // targetPreference=prefer_local must not override an active PR artifact or linked-PR state
    if (targetPreference === DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL) {
      const isLinkedPrState =
        explicitState.target.kind === DEV_LOOP_TARGET_KIND.PR ||
        (explicitState.target.kind === DEV_LOOP_TARGET_KIND.ISSUE && explicitState.target.linkedPr !== null);
      if (isLinkedPrState) {
        return buildInputReconcile(
          "`targetPreference=prefer_local` conflicts with authoritative PR/linked-PR active artifact state; reconcile before overriding the routed path.",
          explicitState,
          effectiveMode,
        );
      }
    }

    return finalizeRoutingResult(applyWatchValidation(
      routeForState(explicitState, { ...routingOptions, executionMode: effectiveMode }),
      watchRequested,
    ));
  }

  if (intent === DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT) {
    if (!explicitState) {
      return buildInputReconcile(
        "`auto_continue_current` requires a valid canonical current state.",
        null,
        DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
      );
    }
    return finalizeRoutingResult(applyWatchValidation(
      routeForState(explicitState, { ...routingOptions, executionMode: effectiveMode }),
      watchRequested,
    ));
  }

  return buildInputReconcile("The public dev-loop intent is recognized but not implemented in this first slice.", null, effectiveMode);
}
