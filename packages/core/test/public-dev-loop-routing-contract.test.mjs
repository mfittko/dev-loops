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

test("public dev-loop routing exports the single public façade name", () => {
  assert.equal(PUBLIC_DEV_LOOP_ENTRYPOINT, "dev-loop");
});

test("public dev-loop routing exposes an explicit gate contract for the current route families", () => {
  assert.deepEqual(
    PUBLIC_DEV_LOOP_GATE_CONTRACT.map(({ gate, routeKind, selectedStrategy }) => ({ gate, routeKind, selectedStrategy })),
    [
      {
        gate: DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED,
        routeKind: DEV_LOOP_ROUTE_KIND.STOP,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
      },
      {
        gate: DEV_LOOP_GATE.STOP_DONE_TERMINAL,
        routeKind: DEV_LOOP_ROUTE_KIND.STOP,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
      },
      {
        gate: DEV_LOOP_GATE.FINAL_APPROVAL,
        routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL,
      },
      {
        gate: DEV_LOOP_GATE.WAITING_FOR_MERGE_AUTHORIZATION,
        routeKind: DEV_LOOP_ROUTE_KIND.STOP,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
      },
      {
        gate: DEV_LOOP_GATE.WAIT_WATCH,
        routeKind: DEV_LOOP_ROUTE_KIND.WAIT,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH,
      },
      {
        gate: DEV_LOOP_GATE.LOCAL_IMPLEMENTATION,
        routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION,
      },
      {
        gate: DEV_LOOP_GATE.ISSUE_INTAKE,
        routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE,
      },
      {
        gate: DEV_LOOP_GATE.EXTERNAL_PR_FOLLOWUP,
        routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.EXTERNAL_PR_FOLLOWUP,
      },
      {
        gate: DEV_LOOP_GATE.REVIEWER_FIXER,
        routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.REVIEWER_FIXER,
      },
      {
        gate: DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP,
        routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP,
      },
      {
        gate: DEV_LOOP_GATE.UI_REVIEW,
        routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW,
      },
      {
        gate: DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE,
        routeKind: DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE,
        selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
      },
    ],
  );
});

test("public contract doc stays aligned with the machine-checkable gate contract", async () => {
  const publicContract = await readFile(publicContractUrl, "utf8");
  const documentedGates = publicContract
    .split("\n")
    .map((line) => line.match(/^\|\s*`([^`]+)`\s*\|/))
    .filter(Boolean)
    .map((match) => match[1]);
  const routingGateSection = documentedGates.slice(
    documentedGates.indexOf(DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED),
    documentedGates.indexOf(DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE) + 1,
  );

  assert.deepEqual(
    routingGateSection,
    PUBLIC_DEV_LOOP_GATE_CONTRACT.map(({ gate }) => gate),
  );

  const finalApprovalSummary = PUBLIC_DEV_LOOP_GATE_CONTRACT.find(({ gate }) => gate === DEV_LOOP_GATE.FINAL_APPROVAL)?.summary;
  const waitingForMergeSummary = PUBLIC_DEV_LOOP_GATE_CONTRACT.find(({ gate }) => gate === DEV_LOOP_GATE.WAITING_FOR_MERGE_AUTHORIZATION)?.summary;

  assert.equal(
    finalApprovalSummary,
    "approval-ready canonical state routes to final approval; merge-ready routes here only when merge authorization is explicit; requires explicit current-head pre_approval_gate evidence — clean-looking signals are not substitutes",
  );
  assert.equal(
    waitingForMergeSummary,
    "merge-ready canonical state without explicit merge authorization stops and waits for merge authorization",
  );
  assert.match(
    publicContract,
    /approval-ready canonical state routes to the human approval checkpoint; merge-ready routes here only when merge authorization is explicit; requires explicit current-head `pre_approval_gate` checkpoint verdict evidence/i,
  );

  const internalStrategySection = publicContract.split("## Internal strategy families")[1]?.split("## Copilot-first issue-assignment seam")[0] ?? "";
  assert.doesNotMatch(internalStrategySection, /\|\s*`waiting_for_merge_authorization`\s*\|/i);
  assert.match(internalStrategySection, /stop gate rather than an internal strategy/i);
});
