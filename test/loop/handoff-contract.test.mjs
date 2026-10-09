import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  HANDOFF_OWNERSHIP,
  HANDOFF_RESUME_POLICY,
  HANDOFF_STOP_BOUNDARY,
  buildHandoffContractForResumeAction,
  compareHandoffContracts,
  parseRecordedHandoffContract,
} from "../../scripts/loop/_handoff-contract.mjs";

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
