import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeHeadScopedCiStatuses,
  normalizeStatusCheckRollupStatus,
  normalizeStatusCheckRollupContract,
  summarizeHeadScopedCheckRunsSignal,
  normalizeHeadScopedCheckRunsStatus,
  normalizeHeadScopedCommitStatus,
  normalizeHeadScopedCiContract,
  deriveLoopCiStatusFromRollup,
  partitionEntriesByCheckName,
  promoteExcludedCleanCiStatus,
  LOOP_DERIVED_CI_CHECK_NAME,
} from "../src/loop/copilot-ci-status.mjs";

test("normalizeStatusCheckRollupStatus returns failure over pending for mixed rollup entries", () => {
  const status = normalizeStatusCheckRollupStatus([
    { status: "IN_PROGRESS", conclusion: null },
    { status: "COMPLETED", conclusion: "FAILURE" },
  ]);

  assert.equal(status, "failure");
});

test("normalizeStatusCheckRollupStatus treats cancelled-only rollup entries as none", () => {
  const status = normalizeStatusCheckRollupStatus([
    { status: "COMPLETED", conclusion: "CANCELLED" },
  ]);

  assert.equal(status, "none");
});

test("normalizeStatusCheckRollupContract emits shared wait semantics for missing rollup", () => {
  const contract = normalizeStatusCheckRollupContract([]);

  assert.equal(contract.overallStatus, "none");
  assert.equal(contract.rollup.none, true);
  assert.equal(contract.semantics.wait, true);
  assert.equal(contract.semantics.blocked, false);
  assert.equal(contract.semantics.timeoutDisposition, "remain_waiting");
});

test("normalizeStatusCheckRollupStatus keeps cancelled completed entries from being masked by success", () => {
  const status = normalizeStatusCheckRollupStatus([
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "COMPLETED", conclusion: "CANCELLED" },
  ]);

  assert.equal(status, "none");
});

test("summarizeHeadScopedCheckRunsSignal preserves unsupported completed conclusions", () => {
  const summary = summarizeHeadScopedCheckRunsSignal({
    check_runs: [
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "CANCELLED" },
    ],
  });

  assert.equal(summary.status, "none");
  assert.equal(summary.unsupportedCompleted, true);
});

test("normalizeHeadScopedCheckRunsStatus returns failure over pending for mixed check runs", () => {
  const status = normalizeHeadScopedCheckRunsStatus({
    check_runs: [
      { status: "IN_PROGRESS", conclusion: null },
      { status: "COMPLETED", conclusion: "FAILURE" },
    ],
  });

  assert.equal(status, "failure");
});

test("normalizeHeadScopedCheckRunsStatus treats cancelled completed check runs as none", () => {
  const status = normalizeHeadScopedCheckRunsStatus({
    check_runs: [
      { status: "COMPLETED", conclusion: "CANCELLED" },
    ],
  });

  assert.equal(status, "none");
});

test("normalizeStatusCheckRollupStatus treats successful status-context rollup entries as success", () => {
  const status = normalizeStatusCheckRollupStatus([
    { state: "SUCCESS" },
  ]);

  assert.equal(status, "success");
});

test("normalizeHeadScopedCheckRunsStatus treats skipped completed check runs as success", () => {
  const status = normalizeHeadScopedCheckRunsStatus({
    check_runs: [
      { status: "COMPLETED", conclusion: "SKIPPED" },
    ],
  });

  assert.equal(status, "success");
});

test("normalizeHeadScopedCheckRunsStatus keeps cancelled completed runs from being masked by success", () => {
  const status = normalizeHeadScopedCheckRunsStatus({
    check_runs: [
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "CANCELLED" },
    ],
  });

  assert.equal(status, "none");
});

test("normalizeHeadScopedCommitStatus returns failure when statuses include error", () => {
  const status = normalizeHeadScopedCommitStatus({
    statuses: [
      { state: "pending" },
      { state: "error" },
    ],
  });

  assert.equal(status, "failure");
});

test("mergeHeadScopedCiStatuses keeps failure-over-pending-over-success precedence", () => {
  assert.equal(mergeHeadScopedCiStatuses("pending", "success"), "pending");
  assert.equal(mergeHeadScopedCiStatuses("success", "failure"), "failure");
  assert.equal(mergeHeadScopedCiStatuses("none", "success"), "success");
});

test("normalizeHeadScopedCiContract emits wait semantics for pending and none", () => {
  const pending = normalizeHeadScopedCiContract({ checkRunsStatus: "pending", commitStatus: "none" });
  assert.equal(pending.overallStatus, "pending");
  assert.equal(pending.rollup.pending, true);
  assert.equal(pending.semantics.wait, true);
  assert.equal(pending.semantics.blocked, false);
  assert.equal(pending.semantics.timeoutDisposition, "remain_waiting");

  const none = normalizeHeadScopedCiContract({ checkRunsStatus: "none", commitStatus: "none" });
  assert.equal(none.overallStatus, "none");
  assert.equal(none.rollup.none, true);
  assert.equal(none.semantics.wait, true);
  assert.equal(none.semantics.blocked, false);
  assert.equal(none.semantics.timeoutDisposition, "remain_waiting");
});

test("normalizeHeadScopedCiContract keeps unsupported completed check-runs from being masked by commit-status success", () => {
  const contract = normalizeHeadScopedCiContract({
    checkRunsStatus: "none",
    commitStatus: "success",
    checkRunsUnsupportedCompleted: true,
  });

  assert.equal(contract.overallStatus, "none");
  assert.equal(contract.semantics.wait, true);
});

test("normalizeHeadScopedCiContract emits blocked semantics for failure", () => {
  const blocked = normalizeHeadScopedCiContract({ checkRunsStatus: "failure", commitStatus: "pending" });

  assert.equal(blocked.overallStatus, "failure");
  assert.equal(blocked.rollup.failure, true);
  assert.equal(blocked.semantics.wait, false);
  assert.equal(blocked.semantics.blocked, true);
  assert.equal(blocked.semantics.timeoutDisposition, "not_applicable");
});

test("summarizeHeadScopedCheckRunsSignal returns failureDetails for failed runs", () => {
  const summary = summarizeHeadScopedCheckRunsSignal({
    check_runs: [
      { status: "COMPLETED", conclusion: "SUCCESS", name: "ci" },
      { status: "COMPLETED", conclusion: "FAILURE", name: "copilot" },
      { status: "COMPLETED", conclusion: "FAILURE", name: "lint" },
    ],
  });

  assert.equal(summary.status, "failure");
  assert.deepEqual(summary.failureDetails, ["copilot", "lint"]);
});

test("summarizeHeadScopedCheckRunsSignal omits empty names from failureDetails", () => {
  const summary = summarizeHeadScopedCheckRunsSignal({
    check_runs: [
      { status: "COMPLETED", conclusion: "FAILURE" },
      { status: "COMPLETED", conclusion: "FAILURE", name: "" },
      { status: "COMPLETED", conclusion: "FAILURE", name: "lint" },
    ],
  });

  assert.equal(summary.status, "failure");
  assert.deepEqual(summary.failureDetails, ["lint"]);
});

test("summarizeHeadScopedCheckRunsSignal returns failureDetails undefined when no failures", () => {
  const summary = summarizeHeadScopedCheckRunsSignal({
    check_runs: [
      { status: "COMPLETED", conclusion: "SUCCESS", name: "ci" },
    ],
  });

  assert.equal(summary.status, "success");
  assert.equal(summary.failureDetails, undefined);
});

// ---------------------------------------------------------------------------
// deriveLoopCiStatusFromRollup / gate-evidence exclusion (#1358)
// ---------------------------------------------------------------------------

test("LOOP_DERIVED_CI_CHECK_NAME is the gate-evidence check", () => {
  assert.equal(LOOP_DERIVED_CI_CHECK_NAME, "gate-evidence");
});

test("partitionEntriesByCheckName splits rollup entries by name/context", () => {
  const { matched, rest } = partitionEntriesByCheckName(
    [
      { name: "gate-evidence", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "test-scripts", status: "COMPLETED", conclusion: "SUCCESS" },
      { context: "gate-evidence" },
    ],
    "gate-evidence",
  );

  assert.equal(matched.length, 2);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].name, "test-scripts");
});

test("promoteExcludedCleanCiStatus promotes success to crediblyGreen only when excluded failures exist", () => {
  assert.equal(promoteExcludedCleanCiStatus("success", ["gate-evidence"]), "crediblyGreen");
  assert.equal(promoteExcludedCleanCiStatus("success", []), "success");
  assert.equal(promoteExcludedCleanCiStatus("failure", ["gate-evidence"]), "failure");
  assert.equal(promoteExcludedCleanCiStatus("pending", ["gate-evidence"]), "pending");
  assert.equal(promoteExcludedCleanCiStatus("none", ["gate-evidence"]), "none");
});

test("deriveLoopCiStatusFromRollup: gate-evidence as the ONLY failing check yields crediblyGreen and excludes it", () => {
  const result = deriveLoopCiStatusFromRollup([
    { name: "gate-evidence", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "test-scripts", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "test-core", status: "COMPLETED", conclusion: "SUCCESS" },
  ]);

  assert.equal(result.status, "crediblyGreen");
  assert.deepEqual(result.excludedFailureDetails, ["gate-evidence"]);
});

test("deriveLoopCiStatusFromRollup: a real failing check alongside gate-evidence still fails (not masked)", () => {
  const result = deriveLoopCiStatusFromRollup([
    { name: "gate-evidence", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "test-scripts", status: "COMPLETED", conclusion: "FAILURE" },
  ]);

  assert.equal(result.status, "failure");
  assert.deepEqual(result.excludedFailureDetails, ["gate-evidence"]);
});

test("deriveLoopCiStatusFromRollup: all-green rollup with no gate-evidence entry is unchanged", () => {
  const result = deriveLoopCiStatusFromRollup([
    { name: "test-scripts", status: "COMPLETED", conclusion: "SUCCESS" },
  ]);

  assert.equal(result.status, "success");
  assert.deepEqual(result.excludedFailureDetails, []);
});

test("deriveLoopCiStatusFromRollup: a passing gate-evidence entry does not get reported as excluded", () => {
  const result = deriveLoopCiStatusFromRollup([
    { name: "gate-evidence", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "test-scripts", status: "COMPLETED", conclusion: "SUCCESS" },
  ]);

  assert.equal(result.status, "success");
  assert.deepEqual(result.excludedFailureDetails, []);
});
