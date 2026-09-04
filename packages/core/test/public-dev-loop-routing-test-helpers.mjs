import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

import {
  RETROSPECTIVE_CHECKPOINT_STATE,
} from "../src/loop/retrospective-checkpoint.mjs";

import {
  DEV_LOOP_ACTOR,
  DEV_LOOP_AUTHORIZATION,
  DEV_LOOP_ARTIFACT_STATE,
  DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION,
  DEV_LOOP_GATE,
  DEV_LOOP_PUBLIC_INTENT,
  DEV_LOOP_EXECUTION_MODE,
  DEV_LOOP_ISSUE_ASSIGNMENT_SEAM,
  DEV_LOOP_ISSUE_ASSIGNMENT_STATE,
  DEV_LOOP_ISSUE_READINESS,
  DEV_LOOP_ROUTE_KIND,
  DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND,
  DEV_LOOP_WAIT_SEMANTICS,
  DEV_LOOP_ISSUE_LINKAGE_RESOLUTION,
  DEV_LOOP_STATUS_REPORT_KIND,
  DEV_LOOP_STATUS,
  DEV_LOOP_TARGET_KIND,
  DEV_LOOP_TARGET_PREFERENCE,
  DEV_LOOP_VARIATION_PARAMETER_CONTRACT,
  INTERNAL_DEV_LOOP_STRATEGY,
  PUBLIC_DEV_LOOP_GATE_CONTRACT,
  PUBLIC_DEV_LOOP_ENTRYPOINT,
  evaluatePublicDevLoopRouting,
  resolveAuthoritativeStartupResumeBundle,
  resolveAuthoritativeDevLoopStatus,
} from "../src/loop/public-dev-loop-routing.mjs";
import {
  EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
  PERSISTENT_INTERNAL_WAIT_TIMEOUT_POLICY,
} from "../src/loop/timeout-policy.mjs";

const publicContractUrl = new URL("../../../skills/docs/public-dev-loop-contract.md", import.meta.url);

function buildCleanPreApprovalGateEvidence(currentHeadSha = "abc1234") {
  return {
    currentHeadSha,
    preApprovalGate: {
      visible: true,
      headSha: currentHeadSha,
      verdict: "clean",
    },
  };
}

function buildVisibleAsyncRun(runId = "run-123") {
  return {
    kind: "pi_managed_run",
    runId,
    visible: true,
  };
}

export {
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
};
