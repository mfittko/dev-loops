import { createHarnessAdapter } from "./adapter.mjs";

/**
 * Create a minimal no-op harness adapter for tests and fallback contexts.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {import("./adapter.mjs").HarnessAdapter}
 */
export function createNoopAdapter({ cwd = "/", env = {} } = {}) {
  return createHarnessAdapter({
    getCwd: () => cwd,
    getEnv: () => env,
    isInteractive: () => false,
    isInsidePi: () => false,
    getRepoRoot: () => cwd,
  });
}
