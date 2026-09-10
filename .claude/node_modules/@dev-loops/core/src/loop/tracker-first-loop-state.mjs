/**
 * Tracker-first loop state machine — pure logic layer.
 *
 * Standalone interpreter that maps a raw tracker/issue state string
 * (plus optional PR context) to a canonical loop state with the same
 * { ok, state, snapshot, allowedTransitions, nextAction } interface as
 * detect-copilot-loop-state.mjs.
 *
 * Fail-closed contract: unknown/ambiguous tracker state maps to `needs_triage`,
 * not to the canonical `unknown` state. Only an explicit `trackerState: "unknown"`
 * produces the `unknown` canonical state.
 */

/** @typedef {"drafting"|"needs_triage"|"in_progress"|"in_review"|"merge_ready"|"blocked"|"completed"|"unknown"} TrackerState */

/** @type {readonly TrackerState[]} */
export const TRACKER_STATES = Object.freeze([
  "drafting",
  "needs_triage",
  "in_progress",
  "in_review",
  "merge_ready",
  "blocked",
  "completed",
  "unknown",
]);

/** @type {Readonly<Record<TrackerState, readonly TrackerState[]>>} */
export const TRACKER_TRANSITIONS = Object.freeze({
  drafting:        ["needs_triage", "blocked", "unknown"],
  needs_triage:    ["in_progress", "blocked", "drafting", "unknown"],
  in_progress:     ["in_review", "blocked", "needs_triage", "unknown"],
  in_review:       ["merge_ready", "in_progress", "blocked", "unknown"],
  merge_ready:     ["completed", "in_review", "blocked", "unknown"],
  blocked:         ["needs_triage", "in_progress", "in_review", "drafting", "unknown"],
  completed:       ["unknown"],
  unknown:         Object.freeze([...TRACKER_STATES]),
});

/**
 * Build a tracker-first loop state snapshot from PR-level tracker data.
 *
 * @param {object} input
 * @param {string} input.trackerState - Raw tracker/issue state (e.g. from gh issue view --jq .state)
 * @param {object} [input.prContext] - Optional PR context (linked PR, CI status)
 * @returns {{ ok: true, state: TrackerState, snapshot: object, allowedTransitions: readonly TrackerState[], nextAction: string }}
 */
export function interpretTrackerLoopState(input) {
  const raw = input.trackerState;

  // Map raw tracker states to canonical states.
  // Fail-closed: unrecognized/ambiguous states → needs_triage.
  // Only explicit "unknown" → the canonical `unknown` state.
  const lower = (raw || "").toLowerCase().trim();
  let state = /** @type {TrackerState} */ ("needs_triage");

  if (lower === "draft" || lower === "drafting") state = "drafting";
  else if (lower === "open" || lower === "needs_triage") state = "needs_triage";
  else if (lower === "in_progress" || lower === "in progress") state = "in_progress";
  else if (lower === "in_review" || lower === "review") state = "in_review";
  else if (lower === "merge_ready" || lower === "ready") state = "merge_ready";
  else if (lower === "blocked") state = "blocked";
  else if (lower === "closed" || lower === "completed" || lower === "done") state = "completed";
  else if (lower === "unknown") state = "unknown";

  const allowedTransitions = TRACKER_TRANSITIONS[state];
  const snapshot = {
    trackerState: state,
    rawTrackerState: raw,
    prLinked: Boolean(input.prContext),
    prContext: input.prContext || null,
  };

  let nextAction = "inspect";
  switch (state) {
    case "drafting":        nextAction = "triage_or_block"; break;
    case "needs_triage":    nextAction = "start_work"; break;
    case "in_progress":     nextAction = "review"; break;
    case "in_review":       nextAction = "merge_or_fix"; break;
    case "merge_ready":     nextAction = "merge"; break;
    case "blocked":         nextAction = "resolve_blocker"; break;
    case "completed":       nextAction = "done"; break;
    default:                nextAction = "reconcile"; break;
  }

  return { ok: true, state, snapshot, allowedTransitions, nextAction };
}
