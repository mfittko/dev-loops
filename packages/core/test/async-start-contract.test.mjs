import assert from "node:assert/strict";
import test from "node:test";

import {
  ASYNC_START_MODE,
  ASYNC_START_STATUS,
  PI_ASYNC_CONTEXT_MARKERS,
  buildAsyncStartRejection,
  validateAsyncStartContext,
} from "../src/loop/async-start-contract.mjs";

// ---------------------------------------------------------------------------
// validateAsyncStartContext: rejection (no markers present)
// ---------------------------------------------------------------------------

test("validateAsyncStartContext: rejects when no Pi context markers are present", () => {
  const result = validateAsyncStartContext({ env: {} });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
  assert.equal(result.detectedMarker, null);
  assert.ok(result.reason.includes("No async context detected"));
});

test("validateAsyncStartContext: rejects when markers are empty strings", () => {
  const env = {
    PI_SUBAGENT_RUN_ID: "",
    PI_SESSION_ID: "",
    PI_ASYNC_CONTEXT: "",
  };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
});

test("validateAsyncStartContext: rejects when markers are whitespace-only", () => {
  const env = {
    PI_SUBAGENT_RUN_ID: "   ",
    PI_SESSION_ID: "\t",
    PI_ASYNC_CONTEXT: " ",
  };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
});

// ---------------------------------------------------------------------------
// validateAsyncStartContext: valid (Pi-managed context detected)
// ---------------------------------------------------------------------------

test("validateAsyncStartContext: valid when PI_SUBAGENT_RUN_ID is set (alias)", () => {
  const env = { PI_SUBAGENT_RUN_ID: "run-abc123" };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.VALID);
  assert.equal(result.detectedMarker, "PI_SUBAGENT_RUN_ID");
});

test("validateAsyncStartContext: valid when the neutral DEVLOOPS_RUN_ID is set", () => {
  const env = { DEVLOOPS_RUN_ID: "devloops-run-1" };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.VALID);
  assert.equal(result.detectedMarker, "DEVLOOPS_RUN_ID");
});

test("validateAsyncStartContext: neutral marker wins when both are set", () => {
  const env = { DEVLOOPS_RUN_ID: "devloops-run-1", PI_SUBAGENT_RUN_ID: "pi-run" };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.VALID);
  assert.equal(result.detectedMarker, "DEVLOOPS_RUN_ID");
});

test("validateAsyncStartContext: rejects when only PI_SESSION_ID is set without a run id", () => {
  const env = { PI_SESSION_ID: "session-xyz" };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
  assert.equal(result.detectedMarker, null);
  assert.ok(result.reason.includes("PI_SUBAGENT_RUN_ID"));
});

test("validateAsyncStartContext: rejects when only PI_ASYNC_CONTEXT is set without a run id", () => {
  const env = { PI_ASYNC_CONTEXT: "1" };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.REJECTED);
  assert.equal(result.detectedMarker, null);
  assert.ok(result.reason.includes("PI_SUBAGENT_RUN_ID"));
});

test("validateAsyncStartContext: first matching marker wins (priority order)", () => {
  const env = {
    PI_SUBAGENT_RUN_ID: "run-1",
    PI_SESSION_ID: "sess-2",
    PI_ASYNC_CONTEXT: "1",
  };
  const result = validateAsyncStartContext({ env });
  assert.equal(result.status, ASYNC_START_STATUS.VALID);
  assert.equal(result.detectedMarker, "PI_SUBAGENT_RUN_ID");
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
    env: { PI_SUBAGENT_RUN_ID: "run-1" },
    asyncStartMode: ASYNC_START_MODE.ALLOWED,
  });
  assert.equal(result.status, ASYNC_START_STATUS.VALID);
  assert.equal(result.detectedMarker, "PI_SUBAGENT_RUN_ID");
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

test("PI_ASYNC_CONTEXT_MARKERS contains expected markers", () => {
  assert.ok(PI_ASYNC_CONTEXT_MARKERS.includes("PI_SUBAGENT_RUN_ID"));
  assert.ok(PI_ASYNC_CONTEXT_MARKERS.includes("DEVLOOPS_RUN_ID"));
  assert.equal(PI_ASYNC_CONTEXT_MARKERS.length, 2);
  assert.equal(PI_ASYNC_CONTEXT_MARKERS[0], "DEVLOOPS_RUN_ID", "neutral marker must be first (precedence)");
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
