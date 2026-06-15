import { createHarnessAdapter } from "./adapter.mjs";

/**
 * Create a minimal harness adapter for tests and fallback/CI/batch contexts.
 *
 * Defaults mirror the current process so swapping from the Pi adapter does not
 * unexpectedly change behavior; callers can still pin cwd/env for determinism.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {import("./adapter.mjs").HarnessAdapter}
 */
export function createNoopAdapter({ cwd = process.cwd(), env = process.env } = {}) {
  return createHarnessAdapter({
    getCwd: () => cwd,
    getEnv: () => env,
    isInteractive: () => false,
    isInsidePi: () => false,
    getRepoRoot: () => cwd,
  });
}
