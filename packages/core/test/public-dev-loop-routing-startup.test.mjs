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

test("authoritative status resolution uses the canonically linked PR identity", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 89, linkedPr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_LINKED_PR,
    loopState: "unresolved_feedback_present",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.equal(report.activeArtifact.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(report.activeArtifact.issue, 89);
  assert.equal(report.activeArtifact.pr, 92);
});

test("authoritative startup/resume bundle resolves routed state with authoritative minimum fields", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 89, linkedPr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_LINKED_PR,
    loopState: "unresolved_feedback_present",
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.activeArtifact.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(bundle.activeArtifact.issue, 89);
  assert.equal(bundle.activeArtifact.pr, 92);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(bundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  assert.equal(
    bundle.issueLinkageResolution,
    DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_LINKED_PR,
  );
});

test("the ui-review intent routes a PR target to the ui_review strategy", () => {
  const prState = {
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 1234 },
    ownership: DEV_LOOP_ACTOR.COPILOT,
    nextActor: DEV_LOOP_ACTOR.USER,
    status: DEV_LOOP_STATUS.ACTIVE,
    authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
  };

  const routed = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.REVIEW_PR_UI,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 1234 },
    currentState: prState,
  });
  assert.equal(routed.selectedGate, DEV_LOOP_GATE.UI_REVIEW);
  assert.equal(routed.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(routed.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW);

  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.REVIEW_PR_UI,
    currentState: prState,
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    loopState: "pr_ui_review_start",
  });
  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.selectedGate, DEV_LOOP_GATE.UI_REVIEW);
  assert.equal(bundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW);
  assert.equal(bundle.activeArtifact.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(bundle.activeArtifact.pr, 1234);
});

test("absent the ui-review intent, a copilot PR target still routes to copilot follow-up", () => {
  const prState = {
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 1234 },
    ownership: DEV_LOOP_ACTOR.COPILOT,
    nextActor: DEV_LOOP_ACTOR.USER,
    status: DEV_LOOP_STATUS.ACTIVE,
    authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
  };
  const routed = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: prState,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });
  assert.equal(routed.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
});

test("authoritative startup/resume bundle fails closed when issue linkage is missing", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
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

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
  assert.equal(bundle.loopState, "unknown");
  assert.match(bundle.nextAction, /reconcile/i);
});

test("authoritative startup/resume bundle fails closed on target identity conflicts", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 93, pr: 99 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.USER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    loopState: "active",
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("authoritative startup/resume bundle fails closed on malformed conflicting target identity fields", () => {
  const issueBundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 93, pr: "99" },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.USER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    loopState: "active",
  });

  const prBundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 93, pr: 99, linkedPr: "101" },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.USER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "active",
  });

  assert.equal(issueBundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(prBundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
});

test("authoritative startup/resume bundle fails closed when artifact state is missing", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "unresolved_feedback_present",
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.artifactState, null);
});

test("authoritative startup/resume bundle fails closed on artifact state conflicts", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.MERGED,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "unresolved_feedback_present",
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.artifactState, DEV_LOOP_ARTIFACT_STATE.MERGED);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
});

test("authoritative startup/resume bundle fails closed on invalid explicit issue linkage resolution", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: "bogus",
    loopState: "unresolved_feedback_present",
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /invalid issue↔PR linkage resolution/i);
});

test("authoritative startup/resume bundle fails closed when loop state is missing or unknown", () => {
  const missingBundle = resolveAuthoritativeStartupResumeBundle({
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

  const unknownBundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 89, pr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "unknown",
  });

  assert.equal(missingBundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(unknownBundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(missingBundle.loopState, "unknown");
  assert.equal(unknownBundle.loopState, "unknown");
});

test("authoritative startup/resume bundle fails closed when routing cannot resolve a strategy", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
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

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("authoritative startup/resume bundle preserves inspect-state semantics when requested", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
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

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);
  assert.match(bundle.nextAction, /Describe the canonical state/i);
});

test("authoritative startup/resume bundle keeps durable wait semantics for linked-PR bootstrap wait states", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
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
    asyncRun: buildVisibleAsyncRun("run-179"),
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(bundle.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(bundle.waitSemantics, DEV_LOOP_WAIT_SEMANTICS.AUTO_HEALTHY_WAIT);
  assert.deepEqual(bundle.waitTimeoutPolicy, EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY);
  assert.equal(bundle.asyncRun?.runId, "run-179");
  assert.equal(bundle.activeArtifact.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(bundle.activeArtifact.issue, 177);
  assert.equal(bundle.activeArtifact.pr, 179);
  assert.match(bundle.nextAction, /remain in durable auto ownership/i);
});

test("authoritative startup/resume bundle reroutes stale bootstrap wait state when refreshed loop state reports linked PR ready", () => {
  const input = {
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 176, linkedPr: 178 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_LINKED_PR,
    asyncRun: buildVisibleAsyncRun("run-178"),
  };

  const waitingBundle = resolveAuthoritativeStartupResumeBundle({
    ...input,
    loopState: "waiting_for_initial_copilot_implementation",
  });
  const readyBundle = resolveAuthoritativeStartupResumeBundle({
    ...input,
    loopState: "linked_pr_ready_for_followup",
  });

  assert.equal(waitingBundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(waitingBundle.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(waitingBundle.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(waitingBundle.activeArtifact.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(waitingBundle.activeArtifact.pr, 178);

  assert.equal(readyBundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(readyBundle.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.equal(readyBundle.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(readyBundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  assert.equal(readyBundle.activeArtifact.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(readyBundle.activeArtifact.issue, 176);
  assert.equal(readyBundle.activeArtifact.pr, 178);
  assert.match(readyBundle.nextAction, /Copilot PR follow-up strategy/i);
});

test("authoritative startup/resume bundle fails closed when linked-pr-ready refresh facts are contradictory", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 176 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    loopState: "linked_pr_ready_for_followup",
    asyncRun: buildVisibleAsyncRun("run-178"),
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /linked_pr_ready_for_followup.*conflicts/i);
});


test("authoritative startup/resume bundle fails closed when refreshed bootstrap state reports a prior linked PR closed unmerged", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
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

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /prior linked PR.*closed unmerged/i);
});

test("authoritative startup/resume bundle preserves inspect routing in durable_auto mode", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
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
    asyncRun: buildVisibleAsyncRun("run-180"),
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);
  assert.equal(bundle.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(bundle.waitSemantics, DEV_LOOP_WAIT_SEMANTICS.AUTO_HEALTHY_WAIT);
  assert.deepEqual(bundle.waitTimeoutPolicy, EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY);
  assert.equal(bundle.asyncRun?.runId, "run-180");
  assert.match(bundle.nextAction, /Describe the canonical state/i);
});

test("authoritative startup/resume bundle reroutes stale bootstrap wait states when linked PR becomes ready for followup", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
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
    asyncRun: buildVisibleAsyncRun("run-181"),
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(bundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  assert.equal(bundle.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(bundle.waitSemantics, DEV_LOOP_WAIT_SEMANTICS.DEFAULT);
  assert.equal(bundle.asyncRun?.runId, "run-181");
  assert.equal(bundle.activeArtifact.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(bundle.activeArtifact.issue, 177);
  assert.equal(bundle.activeArtifact.pr, 179);
  assert.equal(bundle.canonicalState.target.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(bundle.canonicalState.status, DEV_LOOP_STATUS.ACTIVE);
  assert.equal(bundle.loopState, "linked_pr_ready_for_followup");
  assert.match(bundle.nextAction, /Copilot PR follow-up/i);
});

test("authoritative startup/resume bundle fails closed when durable auto has no visible async run", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
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
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /visible registered Pi-managed async run id/i);
});

test("authoritative startup/resume bundle fails closed on detached-process async fallback", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
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

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /detached local background processes do not satisfy the async-start contract/i);
});

test("authoritative startup/resume bundle fails closed on uninspectable pi-managed async run evidence", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
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
      kind: "pi_managed_run",
      runId: "run-188",
      visible: true,
      inspectionState: "uninspectable",
    },
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /uninspectable.*no child message route registered/i);
});

test("authoritative startup/resume bundle fails closed on asyncRun with unrecognized kind", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
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
    asyncRun: { kind: "tmux_session", runId: "x", visible: true },
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /invalid async-run registration/i);
});

test("authoritative startup/resume bundle fails closed on pi_managed_run with null runId", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
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
    asyncRun: { kind: "pi_managed_run", runId: null, visible: true },
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /visible registered Pi-managed async run id/i);
});

test("authoritative startup/resume bundle fails closed on pi_managed_run with visible=false", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
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
    asyncRun: { kind: "pi_managed_run", runId: "run-99", visible: false },
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /visible registered Pi-managed async run id/i);
});

test("authoritative startup/resume bundle fails closed on invalid explicit intent", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: "bogus_intent",
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

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /invalid public dev-loop intent/i);
});

test("targetPreference: PREFER_LOCAL with issue target produces LOCAL_IMPLEMENTATION bundle", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 99 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    issueReadiness: DEV_LOOP_ISSUE_READINESS.READY,
    issueAssignmentState: DEV_LOOP_ISSUE_ASSIGNMENT_STATE.ASSIGNED_TO_COPILOT,
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    loopState: "awaiting_triage",
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(bundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION);
  assert.match(bundle.nextAction, /local implementation strategy/i);
});

test("invalid targetPreference produces NEEDS_RECONCILE whose reason references allowed values text", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    targetPreference: "bogus",
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 99 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    issueReadiness: DEV_LOOP_ISSUE_READINESS.READY,
    issueAssignmentState: DEV_LOOP_ISSUE_ASSIGNMENT_STATE.ASSIGNED_TO_COPILOT,
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    loopState: "awaiting_triage",
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.reason, /invalid targetPreference/i);
  assert.match(bundle.reason, /allowed values/i);
});

test("authoritative startup/resume bundle auto-synthesizes canonical state from issue shorthand — start_issue_locally", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    issue: 484,
    intent: DEV_LOOP_PUBLIC_INTENT.START_ISSUE_LOCALLY,
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "awaiting_triage",
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.activeArtifact.kind, DEV_LOOP_TARGET_KIND.LOCAL_PHASE);
  assert.equal(bundle.activeArtifact.issue, 484);
  assert.equal(bundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION);
  assert.match(bundle.nextAction, /local implementation strategy/i);
});

test("authoritative startup/resume bundle auto-synthesizes canonical state from issue shorthand — start_on_issue", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    issue: 485,
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    artifactState: DEV_LOOP_ARTIFACT_STATE.NOT_APPLICABLE,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR,
    issueReadiness: DEV_LOOP_ISSUE_READINESS.READY,
    issueAssignmentState: DEV_LOOP_ISSUE_ASSIGNMENT_STATE.ASSIGNED_TO_COPILOT,
    loopState: "awaiting_triage",
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.activeArtifact.kind, DEV_LOOP_TARGET_KIND.ISSUE);
  assert.equal(bundle.activeArtifact.issue, 485);
  assert.equal(bundle.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE);
  assert.match(bundle.nextAction, /issue #485 is ready/i);
});

test("authoritative startup/resume bundle falls back to reconcile when issue shorthand has no intent", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    issue: 486,
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
});

test("authoritative startup/resume bundle falls back to reconcile when issue shorthand uses unsupported intent", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    issue: 487,
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
});
