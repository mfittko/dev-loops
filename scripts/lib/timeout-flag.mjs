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

// Issue 3099: a subagent's foreground Bash call is moved to the background after 180 s,
// so one invocation waits at most WAIT_CAP_MS and a longer request is split across re-issues.
export const WAIT_CAP_MS = 170_000;

/**
 * @param {number} requestedMs requested budget (0 stays 0: one immediate check)
 * @returns {{ timeoutMs: number, remainingMs: number }} this invocation's budget and what is left for the re-issue
 */
export function capWait(requestedMs, capMs = WAIT_CAP_MS) {
  return requestedMs > capMs ? { timeoutMs: capMs, remainingMs: requestedMs - capMs } : { timeoutMs: requestedMs, remainingMs: 0 };
}

export const shellWord = (word) => (/^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * The fields a capped wait adds to its non-terminal result: `outcome: "pending"` and the exact
 * command to re-issue, with the original args minus the timeout flags and `--timeout <remaining>`.
 * `carry` maps flag name to value: the first call's wait state (baseline, stall start) rides the
 * re-issue so a resumed call keeps it; a flag already in `argv` is replaced, a null value is skipped,
 * `true` carries a bare flag.
 */
export function pendingFields({ remainingMs, command, argv, carry = {} }) {
  const skipWithValue = new Set(["--timeout", "--timeout-ms", ...Object.keys(carry).filter((flag) => carry[flag] !== true)]);
  const kept = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (skipWithValue.has(argv[i])) i += 1;
    else if (carry[argv[i]] !== true && !/^--timeout(?:-ms)?=/u.test(argv[i])) kept.push(argv[i]);
  }
  const carried = Object.entries(carry).filter(([, value]) => value != null).flatMap(([flag, value]) => (value === true ? [flag] : [flag, String(value)]));
  const remainingTimeoutSeconds = Math.ceil(remainingMs / 1000);
  return { outcome: "pending", remainingTimeoutSeconds, reissue: [command, ...[...kept, ...carried, "--timeout", String(remainingTimeoutSeconds)].map(shellWord)].join(" ") };
}
