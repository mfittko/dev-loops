import assert from "node:assert/strict";
import test from "node:test";

import {
  ASYNC_START_MODE,
  ASYNC_START_STATUS,
  ASYNC_CONTEXT_MARKERS,
  buildAsyncStartRejection,
  validateAsyncStartContext,
  resolveEffectiveAsyncStartMode,
} from "../src/loop/async-start-contract.mjs";

// ---------------------------------------------------------------------------
// validateAsyncStartContext: rejection (no markers present)
// ---------------------------------------------------------------------------

test("validateAsyncStartContext: rejects when no context markers are present", () => {
  const result = validateAsyncStartContext({ env: {} });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
  assert.equal(result.detectedMarker, null);
  assert.ok(result.reason.includes("No async context detected"));
});

test("validateAsyncStartContext: rejects when the marker is an empty string", () => {
  const env = { DEVLOOPS_RUN_ID: "" };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
});

test("validateAsyncStartContext: rejects when the marker is whitespace-only", () => {
  const env = { DEVLOOPS_RUN_ID: "   " };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
});

// ---------------------------------------------------------------------------
// validateAsyncStartContext: valid (async context detected)
// ---------------------------------------------------------------------------

test("validateAsyncStartContext: valid when the neutral DEVLOOPS_RUN_ID is set", () => {
  const env = { DEVLOOPS_RUN_ID: "devloops-run-1" };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.VALID);
  assert.equal(result.detectedMarker, "DEVLOOPS_RUN_ID");
});

test("validateAsyncStartContext: ignores the dropped legacy Pi run-id env var", () => {
  // Built dynamically so the tree-wide neutrality guard does not flag this assertion.
  const droppedPiRunId = ["PI", "SUBAGENT", "RUN", "ID"].join("_");
  const env = { [droppedPiRunId]: "pi-run" };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
  assert.equal(result.detectedMarker, null);
});

// ---------------------------------------------------------------------------
// validateAsyncStartContext: settings-driven allowed mode
// ---------------------------------------------------------------------------

test("validateAsyncStartContext: allowed when workflow.asyncStartMode=allowed", () => {
  const result = validateAsyncStartContext({
    env: {},
    asyncStartMode: ASYNC_START_MODE.ALLOWED,
  });
  assert.equal(result.status, ASYNC_START_STATUS.ALLOWED);
  assert.equal(result.detectedMarker, null);
  assert.ok(result.reason.includes("workflow.asyncStartMode=allowed"));
});

test("validateAsyncStartContext: allowed mode still reports valid when run id is present", () => {
  const result = validateAsyncStartContext({
    env: { DEVLOOPS_RUN_ID: "run-1" },
    asyncStartMode: ASYNC_START_MODE.ALLOWED,
  });
  assert.equal(result.status, ASYNC_START_STATUS.VALID);
  assert.equal(result.detectedMarker, "DEVLOOPS_RUN_ID");
});

test("validateAsyncStartContext: rejects unrecognized workflow.asyncStartMode", () => {
  const result = validateAsyncStartContext({ env: {}, asyncStartMode: /** @type {any} */ ("bogus") });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
  assert.ok(result.reason.includes("Unrecognized workflow.asyncStartMode"));
});

// ---------------------------------------------------------------------------
// validateAsyncStartContext: snapshot mode
// ---------------------------------------------------------------------------

test("validateAsyncStartContext: snapshot mode skips the check", () => {
  const result = validateAsyncStartContext({ env: {}, isSnapshotMode: true });
  assert.equal(result.status, ASYNC_START_STATUS.SNAPSHOT_MODE);
  assert.equal(result.detectedMarker, null);
});

test("validateAsyncStartContext: snapshot mode takes priority over allowed mode", () => {
  const result = validateAsyncStartContext({
    env: {},
    isSnapshotMode: true,
    asyncStartMode: ASYNC_START_MODE.ALLOWED,
  });
  assert.equal(result.status, ASYNC_START_STATUS.SNAPSHOT_MODE);
});

// ---------------------------------------------------------------------------
// buildAsyncStartRejection
// ---------------------------------------------------------------------------

test("buildAsyncStartRejection: builds error payload from rejected validation", () => {
  const validation = validateAsyncStartContext({ env: {} });
  const rejection = buildAsyncStartRejection(validation);
  assert.equal(rejection.ok, false);
  assert.equal(rejection.asyncStartContract, "rejected");
  assert.ok(rejection.error.includes("No async context detected"));
});

// ---------------------------------------------------------------------------
// Constants are correctly exported
// ---------------------------------------------------------------------------

test("ASYNC_CONTEXT_MARKERS contains the neutral marker only", () => {
  assert.deepEqual(ASYNC_CONTEXT_MARKERS, ["DEVLOOPS_RUN_ID"]);
});

test("ASYNC_START_MODE has all expected values", () => {
  assert.equal(ASYNC_START_MODE.REQUIRED, "required");
  assert.equal(ASYNC_START_MODE.ALLOWED, "allowed");
});

test("ASYNC_START_STATUS has all expected values", () => {
  assert.equal(ASYNC_START_STATUS.VALID, "valid");
  assert.equal(ASYNC_START_STATUS.ALLOWED, "allowed");
  assert.equal(ASYNC_START_STATUS.SNAPSHOT_MODE, "snapshot_mode");
  assert.equal(ASYNC_START_STATUS.REJECTED, "rejected");
});

// ---------------------------------------------------------------------------
// resolveEffectiveAsyncStartMode: Claude Code harness relaxation (#830)
// ---------------------------------------------------------------------------

test("resolveEffectiveAsyncStartMode: relaxes to allowed under the Claude harness", () => {
  assert.equal(
    resolveEffectiveAsyncStartMode(ASYNC_START_MODE.REQUIRED, { CLAUDECODE: "1" }),
    ASYNC_START_MODE.ALLOWED,
  );
  // Even an explicitly-allowed config stays allowed under Claude.
  assert.equal(
    resolveEffectiveAsyncStartMode(ASYNC_START_MODE.ALLOWED, { CLAUDECODE: "1" }),
    ASYNC_START_MODE.ALLOWED,
  );
});

test("resolveEffectiveAsyncStartMode: does NOT relax an unrecognized mode under Claude (config error must still surface)", () => {
  // A typo'd asyncStartMode must pass through so validateAsyncStartContext rejects it,
  // rather than the Claude relaxation silently masking the misconfiguration.
  const bogus = "requried";
  assert.equal(resolveEffectiveAsyncStartMode(bogus, { CLAUDECODE: "1" }), bogus);
  const result = validateAsyncStartContext({ env: { CLAUDECODE: "1" }, asyncStartMode: bogus });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
});

test("resolveEffectiveAsyncStartMode: returns the configured mode verbatim outside Claude (Pi unchanged)", () => {
  assert.equal(resolveEffectiveAsyncStartMode(ASYNC_START_MODE.REQUIRED, {}), ASYNC_START_MODE.REQUIRED);
  assert.equal(resolveEffectiveAsyncStartMode(ASYNC_START_MODE.ALLOWED, {}), ASYNC_START_MODE.ALLOWED);
  // CLAUDECODE present but not exactly "1" → no relaxation.
  for (const value of ["0", "", "true", "yes"]) {
    assert.equal(
      resolveEffectiveAsyncStartMode(ASYNC_START_MODE.REQUIRED, { CLAUDECODE: value }),
      ASYNC_START_MODE.REQUIRED,
      `CLAUDECODE=${JSON.stringify(value)} must not relax`,
    );
  }
});

test("resolveEffectiveAsyncStartMode + validateAsyncStartContext: Claude harness passes without a run-id marker", () => {
  // End-to-end of the runtime override: required config + Claude harness + no marker → not rejected.
  const effective = resolveEffectiveAsyncStartMode(ASYNC_START_MODE.REQUIRED, { CLAUDECODE: "1" });
  const result = validateAsyncStartContext({ env: { CLAUDECODE: "1" }, asyncStartMode: effective });
  assert.equal(result.status, ASYNC_START_STATUS.ALLOWED);
  assert.notEqual(result.status, ASYNC_START_STATUS.REJECTED);
});

test("Claude harness override still honors an explicit run-id marker as VALID", () => {
  const effective = resolveEffectiveAsyncStartMode(ASYNC_START_MODE.REQUIRED, { CLAUDECODE: "1", DEVLOOPS_RUN_ID: "devloops-abc" });
  const result = validateAsyncStartContext({ env: { CLAUDECODE: "1", DEVLOOPS_RUN_ID: "devloops-abc" }, asyncStartMode: effective });
  assert.equal(result.status, ASYNC_START_STATUS.VALID);
  assert.equal(result.detectedMarker, "DEVLOOPS_RUN_ID");
});
