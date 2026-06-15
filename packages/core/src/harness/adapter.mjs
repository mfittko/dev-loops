/**
 * Harness adapter interface.
 *
 * Abstracts runtime concerns that vary between agent harnesses (Pi, Claude,
 * local CLI, test) so the dev-loop dispatch and handoff path stays harness-agnostic.
 *
 * This slice is intentionally minimal. Add methods only when the dispatch/handoff
 * path needs them; do not turn the adapter into a generic process wrapper.
 *
 * @typedef {Object} HarnessAdapter
 * @property {() => string} getCwd - Current working directory for the active session.
 * @property {() => NodeJS.ProcessEnv} getEnv - Active environment variables.
 * @property {() => boolean} isInteractive - Whether the session is interactive (vs batch/automated).
 * @property {() => boolean} isInsidePi - Whether the session is running inside the Pi agent harness.
 * @property {() => string} getRepoRoot - Best-effort repository root; falls back to cwd.
 */

const REQUIRED_METHODS = ["getCwd", "getEnv", "isInteractive", "isInsidePi", "getRepoRoot"];

/**
 * Validate and freeze a harness-adapter implementation.
 *
 * @param {Partial<HarnessAdapter>} impl
 * @returns {HarnessAdapter}
 */
export function createHarnessAdapter(impl) {
  if (!impl || typeof impl !== "object") {
    throw new TypeError("createHarnessAdapter: impl must be an object");
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof impl[method] !== "function") {
      throw new TypeError(`createHarnessAdapter: missing required method "${method}"`);
    }
  }

  return Object.freeze({
    getCwd: impl.getCwd,
    getEnv: impl.getEnv,
    isInteractive: impl.isInteractive,
    isInsidePi: impl.isInsidePi,
    getRepoRoot: impl.getRepoRoot,
  });
}

/**
 * Type guard for adapter values.
 *
 * @param {*} value
 * @returns {value is HarnessAdapter}
 */
export function isHarnessAdapter(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return REQUIRED_METHODS.every((method) => typeof value[method] === "function");
}
