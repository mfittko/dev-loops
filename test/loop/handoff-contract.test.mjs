import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  HANDOFF_OWNERSHIP,
  HANDOFF_RESUME_POLICY,
  HANDOFF_STOP_BOUNDARY,
  buildHandoffContractForConductorAction,
  buildHandoffContractForResumeAction,
  compareHandoffContracts,
  parseRecordedHandoffContract,
} from "../../scripts/loop/_handoff-contract.mjs";

test("buildHandoffContractForConductorAction records ownership, stop boundary, and resume policy", () => {
  const subagentContract = buildHandoffContractForConductorAction({
    action: "fix_threads",
    gateBoundary: "feedback_resolution",
  });
  assert.deepEqual(subagentContract, {
    ownership: HANDOFF_OWNERSHIP.SUBAGENT,
    stopBoundary: HANDOFF_STOP_BOUNDARY.SUBAGENT_EXIT,
    resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_SUBAGENT_EXIT,
  });

  const parentContract = buildHandoffContractForConductorAction({
    action: "watch",
    gateBoundary: "post_draft_external_review",
  });
  assert.deepEqual(parentContract, {
    ownership: HANDOFF_OWNERSHIP.PARENT,
    stopBoundary: HANDOFF_STOP_BOUNDARY.WATCH_BOUNDARY,
    resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_STATE_REFRESH,
  });

  const humanContract = buildHandoffContractForConductorAction({
    action: "await_approval",
    gateBoundary: "final_approval_ready",
  });
  assert.deepEqual(humanContract, {
    ownership: HANDOFF_OWNERSHIP.HUMAN,
    stopBoundary: HANDOFF_STOP_BOUNDARY.APPROVAL_BOUNDARY,
    resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_HUMAN_APPROVAL,
  });

  const mergeContract = buildHandoffContractForConductorAction({
    action: "merge",
    requiresApproval: true,
  });
  assert.deepEqual(mergeContract, {
    ownership: HANDOFF_OWNERSHIP.HUMAN,
    stopBoundary: HANDOFF_STOP_BOUNDARY.MERGE_BOUNDARY,
    resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_MERGE_AUTHORIZATION,
  });

  // Copilot review finding (#520): subagent actions with requiresApproval=true
  // must NOT return subagent ownership; they must reflect the approval boundary.
  const subagentWithApproval = buildHandoffContractForConductorAction({
    action: "draft_gate",
    gateBoundary: "draft_gate",
    requiresApproval: true,
  });
  assert.deepEqual(subagentWithApproval, {
    ownership: HANDOFF_OWNERSHIP.HUMAN,
    stopBoundary: HANDOFF_STOP_BOUNDARY.APPROVAL_BOUNDARY,
    resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_HUMAN_APPROVAL,
  });
});

test("buildHandoffContractForResumeAction mirrors recorded handoff intent", () => {
  assert.deepEqual(buildHandoffContractForResumeAction("needs_feedback_fix"), {
    ownership: HANDOFF_OWNERSHIP.SUBAGENT,
    stopBoundary: HANDOFF_STOP_BOUNDARY.SUBAGENT_EXIT,
    resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_SUBAGENT_EXIT,
  });

  assert.deepEqual(buildHandoffContractForResumeAction("await_merge_authorization"), {
    ownership: HANDOFF_OWNERSHIP.HUMAN,
    stopBoundary: HANDOFF_STOP_BOUNDARY.MERGE_BOUNDARY,
    resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_MERGE_AUTHORIZATION,
  });
});

test("parseRecordedHandoffContract parses the explicit contract block and compareHandoffContracts validates it", () => {
  const text = [
    "Active PR: owner/repo#17",
    "Artifact state: open",
    "Handoff ownership: subagent",
    "Stop boundary: subagent_exit",
    "Resume policy: resume_after_subagent_exit",
  ].join("\n");

  const parsed = parseRecordedHandoffContract(text);
  assert.equal(parsed.reason, null);
  assert.deepEqual(parsed.contract, {
    ownership: HANDOFF_OWNERSHIP.SUBAGENT,
    stopBoundary: HANDOFF_STOP_BOUNDARY.SUBAGENT_EXIT,
    resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_SUBAGENT_EXIT,
  });

  const mismatch = compareHandoffContracts(parsed.contract, buildHandoffContractForResumeAction("needs_feedback_fix"));
  assert.equal(mismatch, null);
});

test("parseRecordedHandoffContract fails closed when contract fields are incomplete", () => {
  const parsed = parseRecordedHandoffContract([
    "Active PR: owner/repo#17",
    "Handoff ownership: subagent",
    "Resume policy: resume_after_subagent_exit",
  ].join("\n"));

  assert.equal(parsed.contract, null);
  assert.equal(parsed.reason, "incomplete_handoff_contract");
});
