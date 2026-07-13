/**
 * Centralized policy constants — single source of truth for
 * timeout budgets, poll intervals, and related policy values.
 *
 * These replace the now-removed CLI policy flags (--timeout-ms,
 * --poll-interval-ms, --probe-only, --force, --force-rerequest-review).
 */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Copilot-first durable-wait seam: bootstrap-only PR watch budget */
export const COPILOT_FIRST_DURABLE_WAIT_TIMEOUT_MS = 3_600_000;

/** Copilot review wait: external healthy-wait budget */
export const COPILOT_REVIEW_WAIT_TIMEOUT_MS = 1_800_000;
