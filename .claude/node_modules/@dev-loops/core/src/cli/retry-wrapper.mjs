/**
 * Deterministic retry wrapper for CLI usage/flag errors.
 *
 * When a script receives unknown flags, it emits a usage/flag error to stderr.
 * This wrapper detects such errors, parses the usage output for valid flags,
 * and retries once with corrected args.
 *
 * Only retries on usage/flag errors — NOT on network/auth/data errors.
 *
 * Detection contract:
 *   A usage/flag error is stderr JSON with either the legacy
 *   { ok: false, usage: "..." } shape or the current short-error envelope
 *   { ok: false, hint: "..." } (formatCliError's `usage` presence check
 *   renders as `hint`, never the full usage text — see
 *   packages/core/src/github/review-threads.mjs's formatCliError), OR stderr
 *   text matching known argument-error patterns.
 *
 * Non-retryable: runtime errors ({ ok: false } with neither usage nor hint),
 *   network errors, auth errors, data errors, signal exits.
 *
 * Issue: #483
 */

const USAGE_PATTERNS = [
  /\bUnknown argument:/i,
  /\bMissing required option:/i,
  /\bMissing value for\b/i,
  /\bhas been removed/i,
  /\bUnrecognized\b/i,
  /\bMissing command\b/i,
];

/**
 * Check if stderr represents a CLI usage/flag error that is retryable.
 * @param {string|null|undefined} stderr
 * @returns {boolean}
 */
export function isUsageError(stderr) {
  if (!stderr || stderr.trim().length === 0) return false;

  const trimmed = stderr.trim();

  // Try JSON parse first: legacy { ok: false, usage: "..." }, or the current
  // short-error envelope { ok: false, hint: "..." } (formatCliError never
  // emits `usage` text anymore — a non-empty `hint` is its replacement
  // presence signal that a usage string exists, fetchable via --help).
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && parsed.ok === false) {
      if (typeof parsed.usage === 'string' && parsed.usage.length > 0) return true;
      if (typeof parsed.hint === 'string' && parsed.hint.length > 0) return true;
    }
  } catch {
    // Not JSON — fall through to pattern matching
  }

  return USAGE_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Extract valid flag names from usage text.
 * Finds all --flag-name patterns and returns them as a Set.
 *
 * Only matches flags that look like valid CLI option names:
 * letters and hyphens after --, minimum 2 chars (--x is not a valid flag).
 *
 * @param {string} usageText
 * @returns {Set<string>}
 */
export function extractValidFlags(usageText) {
  const flags = new Set();
  if (!usageText || usageText.length === 0) return flags;

  // Match --flag-name (letters and hyphens after --)
  const flagPattern = /--([a-z][a-z0-9-]*)/gi;
  let match;
  while ((match = flagPattern.exec(usageText)) !== null) {
    flags.add(`--${match[1]}`);
  }
  return flags;
}

/**
 * Extract the canonical usage text from stderr.
 *
 * For JSON stderr: returns the `usage` field value.
 * For non-JSON stderr: tries to find a "Usage:" section and returns that;
 *   if no Usage: section is found, returns null to avoid false positives.
 *
 * @param {string} stderr
 * @returns {string|null}
 */
export function extractUsageText(stderr) {
  if (!stderr || stderr.trim().length === 0) return null;

  try {
    const parsed = JSON.parse(stderr.trim());
    if (parsed && typeof parsed.usage === 'string' && parsed.usage.length > 0) {
      return parsed.usage;
    }
    // JSON but no usage field — not a usage error, don't return raw text
    return null;
  } catch {
    // Not JSON — try to find a "Usage:" section
  }

  const trimmed = stderr.trim();

  // Find "Usage:" line and take from there to end
  const usageIdx = trimmed.search(/^Usage:/im);
  if (usageIdx >= 0) {
    return trimmed.slice(usageIdx);
  }

  // No usage marker — can't reliably extract
  return null;
}

/**
 * Filter original args to keep only recognized flags and their value args.
 * A value arg is the token immediately following a recognized flag
 * that does not start with '-'.
 *
 * @param {string[]} originalArgs
 * @param {Set<string>} validFlags
 * @returns {string[]}
 */
export function filterArgs(originalArgs, validFlags) {
  const filtered = [];
  for (let i = 0; i < originalArgs.length; i++) {
    const arg = originalArgs[i];
    if (validFlags.has(arg)) {
      filtered.push(arg);
      // If next arg exists and doesn't look like a flag, it's a value
      if (i + 1 < originalArgs.length && !originalArgs[i + 1].startsWith('-')) {
        filtered.push(originalArgs[i + 1]);
        i++; // consume the value
      }
    }
  }
  return filtered;
}

/**
 * Build a corrected args array from the original args and the stderr usage error.
 * Returns null if no correction is possible or needed.
 *
 * Steps:
 * 1. Extract canonical usage text from stderr.
 * 2. Extract valid flags from usage text.
 * 3. Filter original args to keep only recognized flags + values.
 * 4. If filtered args differ from original, return them; otherwise return null.
 *
 * @param {string[]} originalArgs
 * @param {string} stderr
 * @returns {string[]|null} Corrected args, or null if no correction needed.
 */
export function buildCorrectedArgs(originalArgs, stderr) {
  if (!originalArgs || originalArgs.length === 0) return null;

  const usageText = extractUsageText(stderr);
  if (!usageText) return null;

  const validFlags = extractValidFlags(usageText);
  if (validFlags.size === 0) return null;

  const corrected = filterArgs(originalArgs, validFlags);
  if (corrected.length === 0) return null;

  // Only retry if args actually changed
  if (corrected.length === originalArgs.length &&
      corrected.every((v, i) => v === originalArgs[i])) {
    return null;
  }

  return corrected;
}
