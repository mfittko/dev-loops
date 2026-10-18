// Shared `--timeout <seconds>` parse for the wait/probe scripts (issue 2755).
// `--timeout-ms` stays one release as a deprecated alias: it warns on stderr
// and converts to seconds. Passing both flags fails closed.
// Node-pure on purpose: no workspace imports.

const NON_NEGATIVE_NUMBER = /^\d+(?:\.\d+)?$/u;

/**
 * @param {{ timeout?: string, timeoutMs?: string }} raw raw flag values (undefined when absent)
 * @param {{ warn?: (message: string) => void }} [deps]
 * @returns {number | undefined} budget in milliseconds, undefined when neither flag is given
 */
export function resolveTimeoutMs({ timeout, timeoutMs }, { warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  if (timeout !== undefined && timeoutMs !== undefined) {
    throw new Error("--timeout and --timeout-ms are mutually exclusive; use --timeout <seconds>");
  }
  if (timeout !== undefined) {
    if (!NON_NEGATIVE_NUMBER.test(timeout)) throw new Error("--timeout must be a non-negative number of seconds");
    const seconds = Number(timeout);
    // A positive value never rounds to 0, which means "one immediate check".
    const ms = seconds > 0 ? Math.max(1, Math.round(seconds * 1000)) : 0;
    if (!Number.isFinite(ms)) throw new Error("--timeout must be a non-negative number of seconds");
    return ms;
  }
  if (timeoutMs !== undefined) {
    if (!/^\d+$/u.test(timeoutMs)) throw new Error("--timeout-ms must be a non-negative integer");
    if (!Number.isFinite(Number(timeoutMs))) throw new Error("--timeout-ms must be a non-negative integer");
    warn(`warning: --timeout-ms is deprecated; use --timeout ${Number(timeoutMs) / 1000} (seconds)`);
    return Number(timeoutMs);
  }
  return undefined;
}
