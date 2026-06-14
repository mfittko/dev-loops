import { execFileSync } from "node:child_process";
import { createHarnessAdapter } from "./adapter.mjs";

/**
 * Create the concrete Pi harness adapter.
 *
 * This is the only active adapter for #765. Future harnesses (Claude, etc.)
 * can implement the same interface without changing call sites.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - Override cwd (default: process.cwd()).
 * @param {NodeJS.ProcessEnv} [options.env] - Override env (default: process.env).
 * @returns {import("./adapter.mjs").HarnessAdapter}
 */
export function createPiAdapter({ cwd = process.cwd(), env = process.env } = {}) {
  function getRepoRoot() {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return cwd;
    }
  }

  function isInteractive() {
    if (env.PI_INTERACTIVE === "0") return false;
    if (env.PI_INTERACTIVE === "1") return true;
    if (env.CI === "true" || env.CI === "1") return false;
    return true;
  }

  function isInsidePi() {
    return env.PI_SESSION === "1" || typeof globalThis.pi !== "undefined";
  }

  return createHarnessAdapter({
    getCwd: () => cwd,
    getEnv: () => env,
    isInteractive,
    isInsidePi,
    getRepoRoot,
  });
}
