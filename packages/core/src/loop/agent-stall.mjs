/**
 * Agent-level stall detection (#1669).
 *
 * A dev-loop child (subagent) that stops making turn progress for N minutes
 * with no pending supervisor request is a stall: the parent should auto-bail
 * to a fresh-context recovery dispatch (carrying the worktree state + a
 * recovery brief) instead of waiting through a manual interrupt+resume
 * round-trip. This is the deterministic detector behind that decision.
 *
 * It deliberately distinguishes a TRUE stall (no turn progress) from a
 * SANCTIONED LONG WATCH (an active bash/subagent tool call that heartbeats
 * its runner claim). The sanctioned-watch heartbeat is the existing
 * runner-coordination `activeRun.updatedAt` (assertRunnerOwnership) — only
 * sanctioned long waits refresh that claim, so a fresh heartbeat means the
 * run is legitimately busy waiting, not stalled.
 *
 * This module is pure and harness-agnostic: it takes millisecond signals and
 * returns a verdict. The CLI probe (`scripts/loop/detect-agent-stall.mjs`)
 * sources those signals from pi run artifacts + runner-coordination state.
 */

export const AGENT_STALL_STATUS = Object.freeze({
  STALLED: "stalled",
  NOT_STALLED: "not_stalled",
  NO_EVIDENCE: "no_evidence",
});

export const AGENT_STALL_REASON = Object.freeze({
  PENDING_REQUEST: "pending_request",
  ACTIVE_TURNS: "active_turns",
  SANCTIONED_WATCH: "sanctioned_watch",
  BELOW_THRESHOLD: "below_threshold",
  NO_SIGNAL: "no_signal",
  DISABLED: "disabled",
});

/**
 * Default no-turn-progress window before a child is treated as stalled.
 * Matches the issue's "e.g. 5min".
 */
export const DEFAULT_AGENT_STALL_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Resolve a positive threshold from a `thresholdMinutes` value, falling back
 * to {@link DEFAULT_AGENT_STALL_THRESHOLD_MS} for missing/invalid input.
 * Mirrors `resolveStaleRunnerMaxAgeMs` conventions in `_stale-runner-detection.mjs`.
 */
export function resolveAgentStallThresholdMs(thresholdMinutes) {
  const n = Number(thresholdMinutes);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_AGENT_STALL_THRESHOLD_MS;
  }
  return Math.floor(n * 60 * 1000);
}

function normalizeMs(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
}

/**
 * Detect whether a dev-loop child has stalled.
 *
 * @param {object} [options]
 * @param {number|string|null} [options.lastActivityAt] Turn-progress signal
 *   (last assistant turn / status `lastActivityAt`). ms or parseable date.
 * @param {number|string|null} [options.sanctionedWatchAt] Sanctioned-watch
 *   heartbeat (runner-coordination `activeRun.updatedAt`). ms or parseable date.
 * @param {boolean} [options.pendingRequest] True when the child is blocked on a
 *   pending supervisor request (never a stall).
 * @param {number|string} [options.now] Reference time (default `Date.now()`).
 * @param {number} [options.thresholdMs] No-turn-progress window.
 * @returns {{status: string, reason: string, stalled: boolean,
 *   turnAgeMs: (number|null), watchAgeMs: (number|null), thresholdMs: number}}
 */
export function detectAgentStall({
  lastActivityAt = null,
  sanctionedWatchAt = null,
  pendingRequest = false,
  now = Date.now(),
  thresholdMs = DEFAULT_AGENT_STALL_THRESHOLD_MS,
} = {}) {
  const nowMs = normalizeMs(now) ?? Date.now();
  const actMs = normalizeMs(lastActivityAt);
  const watchMs = normalizeMs(sanctionedWatchAt);
  const hasTurn = actMs !== null;
  const hasWatch = watchMs !== null;

  if (pendingRequest) {
    return {
      status: AGENT_STALL_STATUS.NOT_STALLED,
      reason: AGENT_STALL_REASON.PENDING_REQUEST,
      stalled: false,
      turnAgeMs: hasTurn ? Math.max(0, nowMs - actMs) : null,
      watchAgeMs: hasWatch ? Math.max(0, nowMs - watchMs) : null,
      thresholdMs,
    };
  }

  if (!hasTurn && !hasWatch) {
    return {
      status: AGENT_STALL_STATUS.NO_EVIDENCE,
      reason: AGENT_STALL_REASON.NO_SIGNAL,
      stalled: false,
      turnAgeMs: null,
      watchAgeMs: null,
      thresholdMs,
    };
  }

  const turnAgeMs = hasTurn ? Math.max(0, nowMs - actMs) : Infinity;
  const watchAgeMs = hasWatch ? Math.max(0, nowMs - watchMs) : Infinity;

  // Active turn progress within the window => clearly not stalled.
  if (turnAgeMs <= thresholdMs) {
    return {
      status: AGENT_STALL_STATUS.NOT_STALLED,
      reason: AGENT_STALL_REASON.ACTIVE_TURNS,
      stalled: false,
      turnAgeMs,
      watchAgeMs: hasWatch ? watchAgeMs : null,
      thresholdMs,
    };
  }

  // No recent turn progress, but a fresh sanctioned-watch heartbeat => the
  // child is legitimately busy waiting on a long watch, NOT stalled (#1669 AC2).
  if (watchAgeMs <= thresholdMs) {
    return {
      status: AGENT_STALL_STATUS.NOT_STALLED,
      reason: AGENT_STALL_REASON.SANCTIONED_WATCH,
      stalled: false,
      turnAgeMs,
      watchAgeMs,
      thresholdMs,
    };
  }

  // No turn progress for the window and no sanctioned-watch heartbeat.
  if (hasTurn) {
    return {
      status: AGENT_STALL_STATUS.STALLED,
      reason: AGENT_STALL_REASON.BELOW_THRESHOLD,
      stalled: true,
      turnAgeMs,
      watchAgeMs: hasWatch ? watchAgeMs : null,
      thresholdMs,
    };
  }

  // No turn signal at all and no fresh watch heartbeat => treat as stalled.
  return {
    status: AGENT_STALL_STATUS.STALLED,
    reason: AGENT_STALL_REASON.NO_SIGNAL,
    stalled: true,
    turnAgeMs: null,
    watchAgeMs: hasWatch ? watchAgeMs : null,
    thresholdMs,
  };
}

/**
 * Build a compact recovery brief for a fresh-context dispatch (#1669 AC3).
 * Carries the worktree/run identity plus a short human-readable "where it
 * stalled" line. Pure string-shaping; the caller supplies the observed facts.
 *
 * @param {object} [options]
 * @param {string|null} [options.runId] Async run id.
 * @param {string|null} [options.cwd] Worktree working directory.
 * @param {string|null} [options.lastAction] Last known action/phase.
 * @param {string} [options.reason] Stall reason token.
 * @returns {{runId: string|null, cwd: string|null, brief: string}}
 */
export function buildAgentStallRecoveryBrief({
  runId = null,
  cwd = null,
  lastAction = null,
  reason = "",
} = {}) {
  const r = typeof runId === "string" && runId.trim().length > 0 ? runId.trim() : null;
  const work = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
  const action = typeof lastAction === "string" && lastAction.trim().length > 0
    ? lastAction.trim()
    : "unknown last action";
  const why = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : "stalled";
  const brief = [
    `Recovery dispatch (${why}) for run ${r ?? "(unknown)"}.`,
    `Worktree: ${work ?? "(unknown)"}.`,
    `Last known action: ${action}.`,
    "Carry forward worktree state and resume from the last known action; do not restart from scratch.",
  ].join(" ");
  return { runId: r, cwd: work, brief, lastAction: action };
}
