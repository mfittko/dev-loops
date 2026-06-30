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

// ── Bounded variation parameter contract regression tests (issue #112) ─────

test("variation parameter contract exports the bounded allow-list, precedence, and disallowed categories", () => {
  assert.deepEqual(
    [...DEV_LOOP_VARIATION_PARAMETER_CONTRACT.allowedParameters],
    ["mode", "watch", "intent", "targetPreference"],
  );
  assert.ok(!DEV_LOOP_VARIATION_PARAMETER_CONTRACT.allowedParameters.includes("issueReadiness"));
  assert.ok(!DEV_LOOP_VARIATION_PARAMETER_CONTRACT.allowedParameters.includes("issueAssignmentState"));
  assert.deepEqual(
    [...DEV_LOOP_VARIATION_PARAMETER_CONTRACT.allowedModeValues],
    [DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO],
  );
  assert.deepEqual(
    [...DEV_LOOP_VARIATION_PARAMETER_CONTRACT.allowedTargetPreferenceValues],
    [DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST, DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL],
  );
  assert.equal(
    DEV_LOOP_VARIATION_PARAMETER_CONTRACT.precedenceOrder[0],
    "authoritative_current_state",
  );
  assert.ok(DEV_LOOP_VARIATION_PARAMETER_CONTRACT.disallowedCategories.includes("arbitrary_ownership_override"));
});

test("mode=durable_auto steers execution mode for continue_current without changing routing", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
});

test("mode=durable_auto without authoritative current state fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.match(result.reason, /mode=durable_auto.*requires a valid authoritative current state/i);
});

test("mode=durable_auto on inspect_state preserves inspect routing with authoritative state", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(result.waitSemantics, DEV_LOOP_WAIT_SEMANTICS.AUTO_HEALTHY_WAIT);
});

test("mode=durable_auto explicit parameter beats the default bounded_handoff mode", () => {
  const withDefault = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
  });

  const withExplicitMode = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
  });

  assert.equal(withDefault.executionMode, DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF);
  assert.equal(withExplicitMode.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(withDefault.selectedGate, withExplicitMode.selectedGate);
  assert.equal(withDefault.selectedStrategy, withExplicitMode.selectedStrategy);
});

test("mode=durable_auto for waiting states sets auto_healthy_wait semantics", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(result.waitSemantics, DEV_LOOP_WAIT_SEMANTICS.AUTO_HEALTHY_WAIT);
});

test("mode=bounded_handoff conflicts with auto_continue_current intent and fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    mode: DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.deepEqual(result.canonicalState?.target, { kind: DEV_LOOP_TARGET_KIND.PR, issue: null, pr: 88, linkedPr: null, branch: null, phase: null });
  assert.match(result.reason, /conflicts with the `auto_continue_current` intent/i);
});

test("unrecognized mode value fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    mode: "some_unknown_mode",
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(result.reason, /unrecognized `mode` parameter/i);
});

test("watch-requested invalid mode preserves watchRequested in contract trace", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    mode: "some_unknown_mode",
    watch: true,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.contractTrace.decision.watchRequested, true);
});

test("auto_continue_current invalid mode preserves derived durable_auto execution mode", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
    mode: "some_unknown_mode",
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.match(result.reason, /unrecognized `mode` parameter/i);
});

test("non-boolean watch value preserves requested durable_auto execution mode", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    watch: "true",
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.match(result.reason, /unrecognized `watch` parameter/i);
});

test("non-boolean watch value fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    watch: "true",
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(result.reason, /unrecognized `watch` parameter/i);
});

test("auto_continue_current non-boolean watch preserves derived durable_auto execution mode", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
    watch: "true",
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.match(result.reason, /unrecognized `watch` parameter/i);
});

test("watch=true succeeds on a wait-capable route", () => {
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

  assert.equal(result.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH);
  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
});

test("watch=true on inspect_state fails closed even when the underlying state is waiting", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    watch: true,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(result.reason, /watch requested but the routed result is not eligible for wait\/watch semantics/i);
  assert.equal(result.contractTrace.decision.watchRequested, true);
  assert.equal(result.contractTrace.stateRefresh.boundaryKind, "post_watch_or_probe");
});

test("watch=true on a non-wait route fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    watch: true,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(result.reason, /watch requested but the routed result is not eligible for wait\/watch semantics/i);
});

test("watch=true on a non-wait PR continue_on_pr route fails closed", () => {
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
    watch: true,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(result.reason, /watch requested but the routed result is not eligible for wait\/watch semantics/i);
});

test("watch=true on a waiting PR succeeds through continue_on_pr", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
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

  assert.equal(result.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH);
});

test("targetPreference=prefer_local steers start_on_issue toward local implementation when no canonical state exists", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL,
  });

  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.LOCAL_IMPLEMENTATION);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION);
  assert.equal(result.canonicalState.target.kind, DEV_LOOP_TARGET_KIND.LOCAL_PHASE);
  assert.equal(result.canonicalState.target.issue, 42);
});

test("targetPreference=prefer_local conflicts with authoritative linked-PR issue state and fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42, linkedPr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(result.reason, /prefer_local.*conflicts with authoritative PR\/linked-PR/i);
});

test("prefer_local reconcile preserves durable_auto execution mode metadata", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.match(result.reason, /prefer_local.*conflicts with authoritative PR\/linked-PR/i);
});

test("targetPreference=prefer_local conflicts with authoritative active PR state in continue_current and fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(result.reason, /prefer_local.*conflicts with authoritative PR\/linked-PR/i);
});

test("targetPreference=prefer_local conflicts with active PR in continue_on_pr and fails closed", () => {
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
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL,
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(result.reason, /prefer_local.*conflicts with authoritative PR\/linked-PR/i);
});

test("targetPreference=prefer_local is the default and does not change routing", () => {
  const withDefault = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
  });

  const withExplicitLocal = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL,
  });

  assert.equal(withDefault.selectedGate, withExplicitLocal.selectedGate);
  assert.equal(withDefault.selectedStrategy, withExplicitLocal.selectedStrategy);
  assert.equal(withDefault.routeKind, withExplicitLocal.routeKind);
});

test("unrecognized targetPreference value fails closed", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: "force_local_anyway",
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.match(result.reason, /unrecognized `targetPreference` parameter/i);
});

test("auto_continue_current invalid targetPreference preserves derived durable_auto execution mode", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
    targetPreference: "force_local_anyway",
  });

  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.match(result.reason, /unrecognized `targetPreference` parameter/i);
});

// Representative translation: formerly name-shaped intent → parameterized dev-loop form
test("representative translation: 'auto dev loop' → mode=durable_auto with continue_current", () => {
  // "auto dev loop" → dev-loop --mode durable_auto
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    mode: DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
});

test("representative translation: 'auto dev loop on issue 112' → auto_continue_current on issue with durable_auto", () => {
  // "auto dev loop on issue 112" → dev-loop --intent auto_continue_current (issue-scoped authoritative state)
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 112 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.ISSUE_INTAKE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE);
});

test("auto_continue_current still routes approval-ready states to final approval by default", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.AUTO_CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 112 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.APPROVAL_READY,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    gateReviewEvidence: buildCleanPreApprovalGateEvidence(),
  });

  assert.equal(result.executionMode, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.FINAL_APPROVAL);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
});

test("approval-ready states fail closed when clean current-head pre-approval gate evidence is missing", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.APPROVAL_READY,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.match(result.reason, /pre_approval_gate/i);
  assert.match(result.reason, /current head sha/i);
});

test("approval-ready with stale pre-approval gate evidence (older head SHA) fails closed — regression: CI green + resolved threads + clean rereview are not sufficient", () => {
  // Regression for issue where CI green, resolved review threads, and clean Copilot
  // rereview led to an approval suggestion even though the pre_approval_gate comment
  // was for an older head SHA, not the current one.
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.APPROVAL_READY,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    gateReviewEvidence: {
      currentHeadSha: "new-sha-123",
      preApprovalGate: {
        visible: true,
        headSha: "old-sha-456",
        verdict: "clean",
      },
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.match(result.reason, /pre_approval_gate/i);
  assert.match(result.reason, /current head sha/i);
});

test("merge-ready with stale pre-approval gate evidence (older head SHA) fails closed — regression: CI green + resolved threads + clean rereview are not sufficient", () => {
  // Same regression, for MERGE_READY status with explicit authorization.
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.MAINTAINER,
      nextActor: DEV_LOOP_ACTOR.MAINTAINER,
      status: DEV_LOOP_STATUS.MERGE_READY,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    gateReviewEvidence: {
      currentHeadSha: "new-sha-123",
      preApprovalGate: {
        visible: true,
        headSha: "old-sha-456",
        verdict: "clean",
      },
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.match(result.reason, /pre_approval_gate/i);
  assert.match(result.reason, /current head sha/i);
});

test("representative translation: 'run dev loop on PR 88 and stay on it' → continue_on_pr + watch", () => {
  // "run dev loop on PR 88 and stay on it" → dev-loop on PR 88 --watch
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
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

  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.WAIT_WATCH);
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.WAIT);
});

test("representative translation: 'prefer the local path for issue 42' → start_on_issue + targetPreference=prefer_local", () => {
  // "prefer the local path for issue 42" → dev-loop on issue 42 --target-preference prefer_local
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 42 },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL,
  });

  assert.equal(result.publicEntrypoint, PUBLIC_DEV_LOOP_ENTRYPOINT);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.LOCAL_IMPLEMENTATION);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION);
  assert.equal(result.canonicalState.target.kind, DEV_LOOP_TARGET_KIND.LOCAL_PHASE);
});


test("retrospective checkpoint gating blocks routed start/resume when checkpoint is missing", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    retrospectiveCheckpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.NONE);
  assert.match(result.nextAction, /retrospective/i);
});

test("retrospective checkpoint gating does not block inspect_state answers", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    retrospectiveCheckpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
});

test("authoritative startup/resume bundle applies retrospective gating when checkpoint is missing", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "copilot_followup_active",
    retrospectiveCheckpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.equal(bundle.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.match(bundle.nextAction, /retrospective/i);
  assert.match(bundle.reason, /retrospective/i);
});

test("authoritative startup/resume bundle preserves inspect semantics despite missing retrospective checkpoint", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "copilot_followup_active",
    retrospectiveCheckpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);
  assert.equal(bundle.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
});

test("authoritative status fails closed when retrospective checkpoint input is invalid", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "copilot_followup_active",
    retrospectiveCheckpointState: "bogus",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.equal(report.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
  assert.match(report.reason, /retrospective checkpoint-state/i);
});


test("authoritative startup/resume bundle preserves the retrospective gate nextAction", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "copilot_followup_active",
    retrospectiveCheckpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.NEEDS_RECONCILE);
  assert.match(bundle.nextAction, /Complete or explicitly skip/i);
  assert.equal(bundle.contractTrace.stateRefresh.loopState, "copilot_followup_active");
  assert.equal(bundle.contractTrace.stateRefresh.artifactState, DEV_LOOP_ARTIFACT_STATE.OPEN);
  assert.equal(bundle.contractTrace.stateRefresh.issueLinkageResolution, DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE);
});

test("authoritative status preserves the retrospective gate nextAction", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "copilot_followup_active",
    retrospectiveCheckpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.match(report.nextAction, /Complete or explicitly skip/i);
  assert.equal(report.contractTrace.stateRefresh.loopState, "copilot_followup_active");
  assert.equal(report.contractTrace.stateRefresh.artifactState, DEV_LOOP_ARTIFACT_STATE.OPEN);
  assert.equal(report.contractTrace.stateRefresh.issueLinkageResolution, DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE);
});

test("retrospective gate rewrites contract trace classification to reconcile", () => {
  const result = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    retrospectiveCheckpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.contractTrace.stopReason.classification, DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.RECONCILE);
  assert.equal(result.contractTrace.decision.selectedGate, DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE);
});

test("authoritative startup/resume bundle carries refreshed wait-state trace context", () => {
  const bundle = resolveAuthoritativeStartupResumeBundle({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "waiting_for_copilot_review",
  });

  assert.equal(bundle.bundleKind, DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND.RESOLVED);
  assert.equal(bundle.contractTrace.decision.contractClassification, DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.HEALTHY_WAIT);
  assert.equal(bundle.contractTrace.stateRefresh.boundaryKind, "startup_resume_refresh");
  assert.equal(bundle.contractTrace.stateRefresh.loopState, "waiting_for_copilot_review");
  assert.equal(bundle.contractTrace.stateRefresh.artifactState, DEV_LOOP_ARTIFACT_STATE.OPEN);
});

test("authoritative status carries resolved wait-state trace context", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.WAITING,
      authorization: DEV_LOOP_AUTHORIZATION.NEEDS_CONFIRMATION,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "waiting_for_copilot_review",
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.RESOLVED);
  assert.equal(report.contractTrace.decision.contractClassification, DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.HEALTHY_WAIT);
  assert.equal(report.contractTrace.stateRefresh.boundaryKind, "authoritative_status_refresh");
  assert.equal(report.contractTrace.stateRefresh.loopState, "waiting_for_copilot_review");
  assert.equal(report.contractTrace.stateRefresh.artifactState, DEV_LOOP_ARTIFACT_STATE.OPEN);
});

test("authoritative status reconcile carries contract trace classification", () => {
  const report = resolveAuthoritativeDevLoopStatus({
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    artifactState: DEV_LOOP_ARTIFACT_STATE.OPEN,
    issueLinkageResolution: DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.NOT_APPLICABLE,
    loopState: "copilot_followup_active",
    retrospectiveCheckpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
  });

  assert.equal(report.statusKind, DEV_LOOP_STATUS_REPORT_KIND.NEEDS_RECONCILE);
  assert.equal(report.contractTrace.stopReason.classification, DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.RECONCILE);
  assert.equal(report.contractTrace.stateRefresh.boundaryKind, "authoritative_status_refresh");
});
