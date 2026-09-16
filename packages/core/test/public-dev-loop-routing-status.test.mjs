import {
  assert,
  buildCleanPreApprovalGateEvidence,
  buildVisibleAsyncRun,
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
  evaluatePublicDevLoopRouting,
  EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
  INTERNAL_DEV_LOOP_STRATEGY,
  PERSISTENT_INTERNAL_WAIT_TIMEOUT_POLICY,
  PUBLIC_DEV_LOOP_ENTRYPOINT,
  PUBLIC_DEV_LOOP_GATE_CONTRACT,
  publicContractUrl,
  readFile,
  resolveAuthoritativeDevLoopStatus,
  resolveAuthoritativeStartupResumeBundle,
  RETROSPECTIVE_CHECKPOINT_STATE,
  test,
} from "./public-dev-loop-routing-test-helpers.mjs";

test("authoritative status resolution does not classify unresolved feedback as final review", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "unresolved_feedback_present",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.VERIFICATION);
  assert.equal(report.loopState, "unresolved_feedback_present");
  assert.equal(report.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.VERIFICATION);
});

test("authoritative status resolution consumes the startup/resume bundle output", () => {
  const input = {
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "unresolved_feedback_present",
  };

  const bundle = resolveAuthoritativeStartupResumeBundle(input);
  const report = resolveAuthoritativeDevLoopStatus(input);

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.deepEqual(report.activeArtifact, bundle.activeArtifact);
  assert.equal(report.artifactState, bundle.artifactState);
  assert.equal(report.loopState, bundle.loopState);
  assert.equal(report.routeKind, bundle.routeKind);
  assert.equal(report.selectedStrategy, bundle.selectedStrategy);
  assert.equal(report.executionMode, bundle.executionMode);
  assert.equal(report.waitSemantics, bundle.waitSemantics);
  assert.equal(report.asyncRun, bundle.asyncRun);
  assert.equal(report.nextAction, bundle.nextAction);
  assert.equal(report.reason, bundle.reason);
});

test("authoritative status resolution ignores inspect intent metadata", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "unresolved_feedback_present",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.doesNotMatch(report.nextAction, /Describe the canonical state/i);
});

test("authoritative status resolution fails closed when routing itself cannot resolve a strategy", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 92 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "awaiting_triage",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(report.loopState, "unknown");
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(report.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("authoritative status resolution fails closed when merged/closed state conflicts with active/open claim", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 91 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.MERGED,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "final_review_gate",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(report.loopState, "unknown");
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
});

test("authoritative status resolution fails closed for issue targets when linkage was not resolved authoritatively", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 93 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.USER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    loopState: "active",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(report.loopState, "unknown");
});

test("authoritative status resolution fails closed when copilot-first issue readiness/assignment seam facts are missing", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 93 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.USER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    loopState: "active",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(report.loopState, "unknown");
});

test("authoritative status resolution accepts issue state only after explicit no-open-PR linkage resolution", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 93 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.USER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    issueReadiness: DEV_LOOP_ISSUE_READINESS.READY,
    issueAssignmentState: DEV_LOOP_ISSUE_ASSIGNMENT_STATE.UNASSIGNED,
    loopState: "active",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.ISSUE_INTAKE);
  assert.equal(report.issueAssignmentSeam, DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.READY_NEEDS_ASSIGNMENT_CONFIRMATION);
  assert.equal(report.activeArtifact.kind, DEV_LOOP_TARGET_KIND.ISSUE);
  assert.equal(report.activeArtifact.issue, 93);
  assert.equal(report.activeArtifact.pr, null);
  assert.equal(
    report.nextAction,
    "Authorize the next mutation: assign copilot-swe-agent to issue #93 now?",
  );
});

test("authoritative status resolution requires assignment before follow-up when issue is ready but still unassigned", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 93 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.USER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    issueReadiness: DEV_LOOP_ISSUE_READINESS.READY,
    issueAssignmentState: DEV_LOOP_ISSUE_ASSIGNMENT_STATE.UNASSIGNED,
    loopState: "active",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.issueAssignmentSeam, DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.READY_ASSIGN_NOW);
  assert.equal(
    report.nextAction,
    "Issue #93 is ready and still unassigned; assign copilot-swe-agent now before PR/bootstrap/watch follow-up.",
  );
});

test("authoritative status resolution allows follow-up once issue is ready and already assigned", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 93 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.USER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    issueReadiness: DEV_LOOP_ISSUE_READINESS.READY,
    issueAssignmentState: DEV_LOOP_ISSUE_ASSIGNMENT_STATE.ASSIGNED_TO_COPILOT,
    loopState: "active",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.issueAssignmentSeam, DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.ASSIGNED_TO_COPILOT);
  assert.equal(
    report.nextAction,
    "Issue #93 is ready and already assigned to copilot-swe-agent; continue into PR/bootstrap/watch follow-up work.",
  );
});

test("authoritative status resolution keeps waiting nextAction for waiting issue states", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 93 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    issueReadiness: DEV_LOOP_ISSUE_READINESS.READY,
    issueAssignmentState: DEV_LOOP_ISSUE_ASSIGNMENT_STATE.ASSIGNED_TO_COPILOT,
    loopState: "waiting_for_copilot",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(report.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH);
  assert.deepEqual(report.waitTimeoutPolicy, PERSISTENT_INTERNAL_WAIT_TIMEOUT_POLICY);
  assert.equal(
    report.nextAction,
    "Keep waiting or watching against the same canonical state instead of switching public loop names.",
  );
});

test("authoritative status resolution keeps waiting linked issue states on the authoritative linked PR artifact", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 89, linkedPr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_LINKED_PR,
    loopState: "waiting_for_external_review",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(report.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH);
  assert.equal(report.activeArtifact.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(report.activeArtifact.issue, 89);
  assert.equal(report.activeArtifact.pr, 92);
  assert.equal(report.artifactState, DEV_LOOP_ARTIFACT_STATE.OPEN);
  assert.equal(
    report.nextAction,
    "Keep waiting or watching against the same canonical state instead of switching public loop names.",
  );
});

test("authoritative status resolution preserves durable healthy-wait semantics for linked-PR bootstrap waits", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 177, linkedPr: 179 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_LINKED_PR,
    loopState: "waiting_for_initial_copilot_implementation",
    asyncRun: buildVisibleAsyncRun("run-181"),
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(report.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(report.waitSemantics, DEV_LOOP_WAIT_SEMANTICS.AUTO_HEALTHY_WAIT);
  assert.deepEqual(report.waitTimeoutPolicy, EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY);
  assert.equal(report.asyncRun?.runId, "run-181");
  assert.match(report.nextAction, /remain in durable auto ownership/i);
});

test("authoritative status resolution reroutes stale bootstrap wait states when linked PR becomes ready for followup", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 177, linkedPr: 179 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_LINKED_PR,
    loopState: "linked_pr_ready_for_followup",
    asyncRun: buildVisibleAsyncRun("run-182"),
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.VERIFICATION);
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(report.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.VERIFICATION);
  assert.equal(report.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(report.waitSemantics, DEV_LOOP_WAIT_SEMANTICS.DEFAULT);
  assert.equal(report.asyncRun?.runId, "run-182");
  assert.equal(report.activeArtifact.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(report.activeArtifact.issue, 177);
  assert.equal(report.activeArtifact.pr, 179);
  assert.equal(report.loopState, "linked_pr_ready_for_followup");
  assert.match(report.nextAction, /verification loop/i);
});


test("authoritative status resolution fails closed when refreshed bootstrap state reports a prior linked PR closed unmerged", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 130 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    issueReadiness: DEV_LOOP_ISSUE_READINESS.READY,
    issueAssignmentState: DEV_LOOP_ISSUE_ASSIGNMENT_STATE.ASSIGNED_TO_COPILOT,
    loopState: "prior_linked_pr_closed_unmerged",
    asyncRun: buildVisibleAsyncRun("run-149"),
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(report.reason, /prior linked PR.*closed unmerged/i);
  assert.match(report.nextAction, /reconcile/i);
});

test("authoritative status resolution fails closed instead of claiming durable auto started without a visible async run", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 186, linkedPr: 188 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_LINKED_PR,
    loopState: "waiting_for_initial_copilot_implementation",
    asyncRun: {
      kind: "detached_process",
      visible: false,
    },
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(report.nextAction, /reconcile/i);
});

test("authoritative status reports approved-but-not-merged PRs as waiting for explicit merge authorization", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 175 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.USER,
      status: DEV_LOOP_STATUS.MERGE_READY,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    gateReviewEvidence: buildCleanPreApprovalGateEvidence(),
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "waiting_for_merge_authorization",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.WAITING_FOR_MERGE_AUTHORIZATION);
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.STOP);
  assert.match(report.nextAction, /wait for explicit merge authorization/i);
});

test("authoritative status resolution fails closed when loop state is the unknown sentinel", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "UnKnOwN",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(report.loopState, "unknown");
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
});

test("authoritative status resolution fails closed when loop state was not explicitly resolved", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(report.loopState, "unknown");
  assert.equal(report.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
});
