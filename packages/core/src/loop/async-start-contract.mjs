/**
 * Async-start contract enforcement for the dev-loop startup path.
 *
 * This module enforces the requirement that dev-loop execution scripts
 * (outer-loop, watch-cycle, etc.) must run within a visible harness-managed async
 * context rather than as detached local processes (nohup, disowned shell jobs,
 * tmux/screen sessions, ad hoc while/sleep loops, etc.).
 *
 * The enforcement seam is a startup check that verifies the presence of an
 * async context marker. When the marker is absent, the check fails closed
 * and returns a machine-readable rejection rather than silently proceeding.
 *
 * Async context markers (required when workflow.asyncStartMode is `required`),
 * neutral-first — see `@dev-loops/core/loop/run-context`:
 * - DEVLOOPS_RUN_ID env var (neutral, harness-agnostic)
 * - PI_SUBAGENT_RUN_ID env var (Pi subagent framework; retained as a compatibility alias)
 *
 * Allowed modes:
 * - workflow.asyncStartMode: required | allowed
 * - Snapshot/test mode (when both --copilot-input and --reviewer-input are provided)
 *   implicitly skips the check since no real async ownership is needed
 *
 * This module is intentionally pure and side-effect free.
 */

import { RUN_ID_MARKERS, isClaudeHarness } from "./run-context.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Environment variable names that indicate an async context, neutral-first.
 * Sourced from the shared run-context contract so the markers stay in one place.
 * The historical name is kept for back-compat; it now includes DEVLOOPS_RUN_ID.
 */
export const PI_ASYNC_CONTEXT_MARKERS = RUN_ID_MARKERS;

/** Supported workflow async-start modes. */
export const ASYNC_START_MODE = Object.freeze({
  REQUIRED: "required",
  ALLOWED: "allowed",
});

/** Async-start validation result status values. */
export const ASYNC_START_STATUS = Object.freeze({
  /** A valid harness-managed async context was detected. */
  VALID: "valid",
  /** The workflow explicitly allows non-async startup for this context. */
  ALLOWED: "allowed",
  /** The check was skipped because the caller is in snapshot/test mode. */
  SNAPSHOT_MODE: "snapshot_mode",
  /** No harness-managed async context was detected; fail closed. */
  REJECTED: "rejected",
});

/**
 * Resolve the effective async-start mode for the current harness.
 *
 * The async-start contract is configurable via `workflow.asyncStartMode`
 * (`required` | `allowed`) — see defaults.yaml. It exists to stop the Pi
 * harness from running the loop as a detached, uninspectable background
 * process. Claude Code's Agent tool has no detached-process variant (each
 * subagent run is visible and inspectable), so under the Claude harness a
 * *recognized* mode is relaxed to `allowed` at runtime. An unrecognized
 * (e.g. typo'd) `configuredMode` is returned verbatim — not relaxed — so
 * `validateAsyncStartContext` still rejects it and the config error surfaces
 * even under Claude. Pi behavior is unchanged: outside Claude the configured
 * mode is always returned verbatim.
 *
 * @param {string} configuredMode - Mode from workflow config; normally
 *   `"required"` | `"allowed"`, but any value is accepted and an unrecognized
 *   one is passed through unchanged for downstream validation.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} The effective mode (`"allowed"` when a recognized mode is
 *   relaxed under Claude; otherwise `configuredMode` verbatim).
 */
export function resolveEffectiveAsyncStartMode(configuredMode, env = process.env) {
  // Only relax a recognized mode. An unrecognized configuredMode must pass through
  // verbatim so validateAsyncStartContext still rejects it (surfacing the config
  // error) rather than having the Claude relaxation silently mask a typo'd value.
  const isRecognizedMode =
    configuredMode === ASYNC_START_MODE.REQUIRED || configuredMode === ASYNC_START_MODE.ALLOWED;
  if (isRecognizedMode && isClaudeHarness(env)) {
    return ASYNC_START_MODE.ALLOWED;
  }
  return configuredMode;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that the current execution context is a visible harness-managed async run.
 *
 * Returns a result object describing whether the check passed, was allowed by
 * config, or was rejected. Callers should treat `rejected` as a hard stop.
 *
 * @param {object} params
 * @param {Record<string, string|undefined>} [params.env] - Environment variables to inspect.
 * @param {boolean} [params.isSnapshotMode] - True when running in snapshot/test input mode.
 * @param {"required"|"allowed"} [params.asyncStartMode] - Settings-driven async-start mode.
 * @returns {{ status: string, reason: string, detectedMarker: string|null }}
 */
export function validateAsyncStartContext({
  env = process.env,
  isSnapshotMode = false,
  asyncStartMode = ASYNC_START_MODE.REQUIRED,
} = {}) {
  // Snapshot/test mode implicitly skips — no real async ownership needed
  if (isSnapshotMode) {
    return {
      status: ASYNC_START_STATUS.SNAPSHOT_MODE,
      reason: "Snapshot/test input mode; async-start check not required.",
      detectedMarker: null,
    };
  }

  if (
    asyncStartMode !== ASYNC_START_MODE.REQUIRED &&
    asyncStartMode !== ASYNC_START_MODE.ALLOWED
  ) {
    return {
      status: ASYNC_START_STATUS.REJECTED,
      reason:
        `Unrecognized workflow.asyncStartMode value ${JSON.stringify(asyncStartMode)}. ` +
        `Expected ${ASYNC_START_MODE.REQUIRED} or ${ASYNC_START_MODE.ALLOWED}.`,
      detectedMarker: null,
    };
  }

  // Check for any async context marker (neutral DEVLOOPS_RUN_ID or the Pi alias)
  for (const marker of PI_ASYNC_CONTEXT_MARKERS) {
    const value = env[marker];
    if (typeof value === "string" && value.trim().length > 0) {
      return {
        status: ASYNC_START_STATUS.VALID,
        reason: `Async context detected via ${marker}.`,
        detectedMarker: marker,
      };
    }
  }

  if (asyncStartMode === ASYNC_START_MODE.ALLOWED) {
    return {
      status: ASYNC_START_STATUS.ALLOWED,
      reason: "Async-start check allowed by workflow.asyncStartMode=allowed.",
      detectedMarker: null,
    };
  }

  const sessionOnlyMarker =
    (typeof env.PI_SESSION_ID === "string" && env.PI_SESSION_ID.trim().length > 0)
      ? "PI_SESSION_ID"
      : ((typeof env.PI_ASYNC_CONTEXT === "string" && env.PI_ASYNC_CONTEXT.trim().length > 0)
          ? "PI_ASYNC_CONTEXT"
          : null);
  if (sessionOnlyMarker !== null) {
    return {
      status: ASYNC_START_STATUS.REJECTED,
      reason:
        `Detected ${sessionOnlyMarker}, but GitHub-first async-start requires a visible ` +
        "subagent run id for inspectable startup/resume evidence. " +
        "Set DEVLOOPS_RUN_ID (or the PI_SUBAGENT_RUN_ID alias) to proceed. Any exception must come from repository-maintained workflow policy.",
      detectedMarker: null,
    };
  }

  if (env.PI_DEV_LOOP_DETACHED === "1") {
    return {
      status: ASYNC_START_STATUS.REJECTED,
      reason:
        "Detected detached local background execution; detached/local fallback is diagnostic-only " +
        "and does not satisfy the async-start contract. Restart via harness-managed async mode. " +
        "Any relaxed posture must come from repository-maintained workflow policy.",
      detectedMarker: null,
    };
  }

  // No marker found — fail closed
  return {
    status: ASYNC_START_STATUS.REJECTED,
    reason:
      "No async context detected. " +
      "The dev-loop must run within a visible async subagent session, " +
      "not as a detached local process. " +
      `Set ${PI_ASYNC_CONTEXT_MARKERS[0]} (or the PI_SUBAGENT_RUN_ID alias) to proceed. ` +
      "Repository-maintained workflow policy controls any exceptions.",
    detectedMarker: null,
  };
}

/**
 * Build a fail-closed error payload for rejected async-start validation.
 *
 * This returns the same JSON error shape used by the CLI scripts so callers
 * can emit it on stderr and exit non-zero.
 *
 * @param {{ status: string, reason: string }} validationResult
 * @returns {{ ok: false, error: string, asyncStartContract: string }}
 */
export function buildAsyncStartRejection(validationResult) {
  return {
    ok: false,
    error: validationResult.reason,
    asyncStartContract: "rejected",
  };
}
