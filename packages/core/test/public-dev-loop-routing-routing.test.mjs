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

test("start_on_issue routes to issue_intake through the public dev-loop façade", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.ISSUE_INTAKE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE);
  assert.equal(result.canonicalState.target.kind, DEV_LOOP_TARGET_KIND.ISSUE);
  assert.equal(result.canonicalState.nextActor, DEV_LOOP_ACTOR.USER);
  assert.equal(result.canonicalState.authorization, DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION);
  assert.equal(result.issueAssignmentSeam, DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.READY_NEEDS_ASSIGNMENT_CONFIRMATION);
  assert.equal(result.nextAction, "Authorize the next mutation: assign copilot-swe-agent to issue #86 now?");
  assert.doesNotMatch(result.nextAction, /approval gate/i);
});

test("copilot-first unassigned issue stops for clarification when readiness is missing", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    issueReadiness: DEV_LOOP_ISSUE_READINESS.NEEDS_CLARIFICATION,
    issueAssignmentState: DEV_LOOP_ISSUE_ASSIGNMENT_STATE.UNASSIGNED,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.ISSUE_INTAKE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.STOP);
  assert.equal(result.issueAssignmentSeam, DEV_LOOP_ISSUE_ASSIGNMENT_SEAM.NEEDS_REFINEMENT);
  assert.match(result.nextAction, /ask focused clarification questions/i);
  assert.match(result.nextAction, /stop before assigning copilot-swe-agent/i);
});

test("clarification stops emit blocked contract trace classification", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    issueReadiness: DEV_LOOP_ISSUE_READINESS.NEEDS_CLARIFICATION,
    issueAssignmentState: DEV_LOOP_ISSUE_ASSIGNMENT_STATE.UNASSIGNED,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.STOP);
  assert.equal(result.contractTrace.stopReason.classification, DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.BLOCKED);
});

test("start_on_issue with a linked PR routes directly to PR follow-up", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86, linkedPr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  assert.equal(result.canonicalState.target.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(result.canonicalState.target.pr, 88);
});

test("start_on_issue with a linked PR keeps that PR canonical instead of opening another PR", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 126 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 126, linkedPr: 260 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.equal(result.canonicalState.target.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(result.canonicalState.target.pr, 260);
  assert.match(result.nextAction, /canonical artifact/i);
  assert.match(result.nextAction, /do not open a second PR/i);
  assert.match(result.reason, /already-open linked PR must stay canonical/i);
});


test("start_on_issue with valid canonical PR state for the same issue routes from that state", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 86, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  assert.equal(result.canonicalState.target.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(result.canonicalState.target.pr, 88);
});

test("start_on_issue with conflicting canonical issue state fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 999, linkedPr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("start_on_issue with a canonical PR state that cannot be matched to the issue fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("issue targets carrying a pr field fail closed in public routing", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("pr targets carrying a linkedPr field fail closed in public routing", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 86, pr: 88, linkedPr: 99 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("issue targets with malformed linkedPr fail closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86, linkedPr: "88" },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("provided canonical current state must include a target", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    currentState: {
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("start_issue_locally_then_continue routes first to local implementation without changing the public entrypoint", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ISSUE_LOCALLY_THEN_CONTINUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
  });

  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION);
  assert.equal(result.canonicalState.target.kind, DEV_LOOP_TARGET_KIND.LOCAL_PHASE);
  assert.match(result.nextAction, /re-enter the same public `dev-loop` entrypoint/i);
});

test("start_issue_locally with invalid canonical state fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ISSUE_LOCALLY,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    currentState: {
      ownership: DEV_LOOP_ACTOR.LOCAL,
      nextActor: DEV_LOOP_ACTOR.LOCAL,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("start_issue_locally with conflicting canonical state fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ISSUE_LOCALLY,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, issue: 86, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("continue_on_pr routes Copilot-owned PR follow-up to the compatibility copilot-dev-loop strategy", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
});

test("continue_on_pr with conflicting canonical PR state fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 99 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("continue_current routes external-human PR ownership to the external PR follow-up strategy", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 91 },
      ownership: DEV_LOOP_ACTOR.EXTERNAL_HUMAN,
      nextActor: DEV_LOOP_ACTOR.REVIEWER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.EXTERNAL_PR_FOLLOWUP);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.EXTERNAL_PR_FOLLOWUP);
});

test("blocked and not-authorized states stop instead of routing", () => {
  for (const currentState of [
    {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.BLOCKED,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NOT_AUTHORIZED,
    },
    {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.APPROVAL_READY,
      authorization: DEV_LOOP_AUTHORIZATION.NOT_AUTHORIZED,
    },
  ]) {
    const result = evaluatePublicDevLoopRouting({
      intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
      currentState,
      targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
    });

    assert.equal(result.selectedGate, DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED);
    assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.STOP);
    assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
  }
});

test("done states stop as terminal states", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.DONE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.STOP_DONE_TERMINAL);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.STOP);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});

test("approval-ready states route to final approval and keep merge authorization separate", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.APPROVAL_READY,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    gateReviewEvidence: buildCleanPreApprovalGateEvidence(),
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FINAL_APPROVAL);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL);
  assert.match(result.nextAction, /do not treat approval as merge authorization/i);
  assert.doesNotMatch(result.nextAction, /approval\/merge/i);
});

test("merge-ready states without merge authorization stop in waiting_for_merge_authorization", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.MERGE_READY,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    gateReviewEvidence: buildCleanPreApprovalGateEvidence(),
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.WAITING_FOR_MERGE_AUTHORIZATION);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.STOP);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
  assert.match(result.nextAction, /wait for explicit merge authorization/i);
  assert.match(result.nextAction, /ambiguous/i);
  assert.match(result.reason, /must stop and wait/i);
});

test("authorization-gated stops emit contract trace classification", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.MERGE_READY,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    gateReviewEvidence: buildCleanPreApprovalGateEvidence(),
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.contractTrace.stopReason.classification, DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.AUTHORIZATION_GATED);
  assert.equal(result.contractTrace.stopReason.terminal, false);
  assert.match(result.contractTrace.stopReason.reason, /must stop and wait/i);
});

test("merge-ready states with explicit merge authorization may proceed to final approval merge step", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.MERGE_READY,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    gateReviewEvidence: buildCleanPreApprovalGateEvidence(),
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FINAL_APPROVAL);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL);
  assert.match(result.nextAction, /merge is explicitly authorized/i);
});

test("waiting states remain deterministic wait/watch states", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF);
  assert.equal(result.waitSemantics, DEV_LOOP_WAIT_SEMANTICS.DEFAULT);
  assert.deepEqual(result.waitTimeoutPolicy, PERSISTENT_INTERNAL_WAIT_TIMEOUT_POLICY);
});

test("wait/watch routing emits deterministic contract trace instrumentation", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    watch: true,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.contractTrace.decision.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(result.contractTrace.decision.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH);
  assert.equal(result.contractTrace.decision.contractClassification, DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.HEALTHY_WAIT);
  assert.equal(result.contractTrace.waitStrategy.waitMode, "persistent_watch");
  assert.equal(result.contractTrace.waitStrategy.timeoutPolicyClassification, PERSISTENT_INTERNAL_WAIT_TIMEOUT_POLICY.classification);
  assert.equal(result.contractTrace.waitStrategy.effectiveTimeoutMs, PERSISTENT_INTERNAL_WAIT_TIMEOUT_POLICY.defaultTimeoutMs);
  assert.equal(result.contractTrace.stateRefresh.boundaryKind, "post_watch_or_probe");
  assert.equal(result.contractTrace.stateRefresh.refreshRequired, true);
});

test("waiting linked issue states route as the authoritative linked PR artifact", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 89, linkedPr: 92 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH);
  assert.equal(result.canonicalState.target.kind, DEV_LOOP_TARGET_KIND.PR);
  assert.equal(result.canonicalState.target.issue, 89);
  assert.equal(result.canonicalState.target.pr, 92);
  assert.equal(result.canonicalState.target.linkedPr, null);
});

test("waiting states with local ownership still route through the shared wait/watch strategy", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.LOCAL_PHASE, issue: 86, phase: "issue-86" },
      ownership: DEV_LOOP_ACTOR.LOCAL,
      nextActor: DEV_LOOP_ACTOR.LOCAL,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH);
});

test("auto_continue_current routes detected state with durable auto execution mode", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(result.waitSemantics, DEV_LOOP_WAIT_SEMANTICS.DEFAULT);
});

test("auto_continue_current keeps healthy watch states non-escalating", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(result.waitSemantics, DEV_LOOP_WAIT_SEMANTICS.AUTO_HEALTHY_WAIT);
  assert.deepEqual(result.waitTimeoutPolicy, EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY);
  assert.match(result.nextAction, /do not escalate timeout\/no-activity alone as attention/i);
});

test("auto_continue_current without canonical state fails closed with durable_auto execution mode", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
  });
  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.match(result.reason, /auto_continue_current.*requires a valid canonical current state/i);
});

test("auto_continue_current with blocked or not-authorized state still stops (escalates)", () => {
  for (const currentState of [
    {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.BLOCKED,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NOT_AUTHORIZED,
    },
  ]) {
    const result = evaluatePublicDevLoopRouting({
      intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
      currentState,
    });
    assert.equal(result.selectedGate, DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED);
    assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.STOP);
    assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  }
});

test("inspect_state reports the canonical state without switching public entrypoints", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.LOCAL_BRANCH, branch: "feature/issue-86" },
      ownership: DEV_LOOP_ACTOR.LOCAL,
      nextActor: DEV_LOOP_ACTOR.LOCAL,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.LOCAL_IMPLEMENTATION);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION);
  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
});

test("missing intent preserves requested durable_auto execution-mode metadata", () => {
  const result = evaluatePublicDevLoopRouting({
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.match(result.reason, /intent is missing or unrecognized/i);
});

test("watch validation preserves existing reconcile reasons", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    watch: true,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(result.reason, /does not map cleanly to any first-slice internal strategy/i);
});


test("watch validation preserves existing stop results", () => {
  const blockedResult = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.BLOCKED,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    watch: true,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  const doneResult = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.DONE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    watch: true,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(blockedResult.selectedGate, DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED);
  assert.equal(blockedResult.routeKind, DEV_LOOP_ROUTE_KIND.STOP);
  assert.match(blockedResult.reason, /blocked or not authorized/i);

  assert.equal(doneResult.selectedGate, DEV_LOOP_GATE.STOP_DONE_TERMINAL);
  assert.equal(doneResult.routeKind, DEV_LOOP_ROUTE_KIND.STOP);
  assert.match(doneResult.reason, /already done/i);
});


test("watch validation preserves inspect-wrapped stop and reconcile outcomes", () => {
  const inspectBlockedResult = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.BLOCKED,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    watch: true,
  });

  const inspectReconcileResult = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    watch: true,
  });

  assert.equal(inspectBlockedResult.selectedGate, DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED);
  assert.equal(inspectBlockedResult.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);
  assert.match(inspectBlockedResult.reason, /blocked or not authorized/i);

  assert.equal(inspectReconcileResult.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(inspectReconcileResult.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);
  assert.match(inspectReconcileResult.reason, /does not map cleanly to any first-slice internal strategy/i);
});

test("invalid or incomplete inputs fail closed to needs_reconcile", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
});
