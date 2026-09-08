import assert from "node:assert/strict";
import { test } from "bun:test";
import { observeHeadCiSignals } from "../../scripts/github/observe-head-ci.mjs";

// Dispatch the two parallel `gh api` reads by endpoint. Each entry is a
// { code, stdout } result; omit an entry to default to a clean exit-0 empty read.
function stubRunChild({ checkRuns, statuses }) {
  return async (_ghCommand, args) => {
    const url = args[1] ?? "";
    if (url.includes("/check-runs")) return checkRuns ?? { code: 0, stdout: JSON.stringify({ check_runs: [] }) };
    if (url.includes("/status")) return statuses ?? { code: 0, stdout: JSON.stringify({ statuses: [] }) };
    throw new Error(`unexpected gh api url: ${url}`);
  };
}

function observe(stub, { prVisibleCheckNames } = {}) {
  return observeHeadCiSignals(
    { repo: "owner/repo", headSha: "abc", prVisibleCheckNames },
    { env: {}, ghCommand: "gh", runChild: stub },
  );
}

test("valid check-runs + commit statuses parse into raw signals", async () => {
  const { checkRuns, statuses } = await observe(
    stubRunChild({
      checkRuns: { code: 0, stdout: JSON.stringify({ check_runs: [{ name: "build", status: "completed", conclusion: "success" }] }) },
      statuses: { code: 0, stdout: JSON.stringify({ statuses: [{ context: "ci/circleci", state: "success" }] }) },
    }),
  );
  assert.equal(checkRuns.ok, true);
  assert.equal(checkRuns.rawCount, 1);
  assert.equal(checkRuns.nonLoopDerivedCount, 1);
  assert.equal(checkRuns.visibleSignal.status, "success");
  assert.equal(statuses.ok, true);
  assert.equal(statuses.commitStatus, "success");
  assert.equal(statuses.rawCount, 1);
  assert.deepEqual(statuses.statusFailures, []);
});

test("unavailable read (non-zero exit) is ok:false, never fabricated empty", async () => {
  const { checkRuns, statuses } = await observe(
    stubRunChild({
      checkRuns: { code: 1, stdout: "" },
      statuses: { code: 1, stdout: "" },
    }),
  );
  assert.equal(checkRuns.ok, false);
  assert.equal(checkRuns.rawCount, null);
  assert.equal(statuses.ok, false);
  assert.equal(statuses.commitStatus, null);
});

test("malformed payload (exit 0, missing array) is ok:false, not empty", async () => {
  const { checkRuns, statuses } = await observe(
    stubRunChild({
      checkRuns: { code: 0, stdout: JSON.stringify({ unexpected: true }) },
      statuses: { code: 0, stdout: "not json" },
    }),
  );
  assert.equal(checkRuns.ok, false);
  assert.equal(statuses.ok, false);
});

test("explicit-empty reads settle ok:true with zero counts and none status", async () => {
  const { checkRuns, statuses } = await observe(stubRunChild({}));
  assert.equal(checkRuns.ok, true);
  assert.equal(checkRuns.rawCount, 0);
  assert.equal(checkRuns.nonLoopDerivedCount, 0);
  assert.equal(checkRuns.visibleSignal.status, "none");
  assert.equal(statuses.ok, true);
  assert.equal(statuses.rawCount, 0);
  assert.equal(statuses.commitStatus, "none");
});

test("loop-derived gate-evidence is excluded from counts and surfaced separately", async () => {
  const { checkRuns, statuses } = await observe(
    stubRunChild({
      checkRuns: { code: 0, stdout: JSON.stringify({ check_runs: [{ name: "gate-evidence-runner", status: "completed", conclusion: "failure" }] }) },
      statuses: { code: 0, stdout: JSON.stringify({ statuses: [{ context: "gate-evidence", state: "failure" }] }) },
    }),
  );
  // Raw length keeps it; the non-loop-derived count drops it.
  assert.equal(checkRuns.rawCount, 1);
  assert.equal(checkRuns.nonLoopDerivedCount, 0);
  assert.deepEqual(checkRuns.loopDerivedFailureDetails, ["gate-evidence"]);
  assert.equal(checkRuns.fullSignal.status, "none");
  assert.equal(statuses.nonLoopDerivedCount, 0);
  assert.deepEqual(statuses.excludedFailureDetails, ["gate-evidence"]);
  assert.equal(statuses.commitStatus, "none");
});

test("hidden (not PR-visible) runs split into excludedSignal, out of visibleSignal", async () => {
  const { checkRuns } = await observe(
    stubRunChild({
      checkRuns: { code: 0, stdout: JSON.stringify({ check_runs: [
        { name: "visible", status: "completed", conclusion: "success" },
        { name: "hidden", status: "completed", conclusion: "failure" },
      ] }) },
    }),
    { prVisibleCheckNames: ["visible"] },
  );
  assert.equal(checkRuns.visibleSignal.status, "success");
  assert.equal(checkRuns.excludedSignal.status, "failure");
  assert.deepEqual(checkRuns.excludedSignal.failureDetails, ["hidden"]);
  // fullSignal keeps the hidden failure; it drives the cautious unsupported/none override.
  assert.equal(checkRuns.fullSignal.status, "failure");
  assert.equal(checkRuns.nonLoopDerivedCount, 2);
});

test("failed commit-status contexts are listed in statusFailures", async () => {
  const { statuses } = await observe(
    stubRunChild({
      statuses: { code: 0, stdout: JSON.stringify({ statuses: [{ context: "ci/circleci", state: "failure" }] }) },
    }),
  );
  assert.equal(statuses.commitStatus, "failure");
  assert.deepEqual(statuses.statusFailures, [{ name: "ci/circleci", conclusion: "failure" }]);
});
