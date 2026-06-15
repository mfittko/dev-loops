/**
 * Deterministic state machine for the tracker-first story-to-PR lifecycle.
 *
 * This module provides:
 * - TRACKER_PR_STATE: stable state name constants
 * - normalizeTrackerPrSnapshot: validate and canonicalize a raw snapshot
 * - interpretTrackerPrState: map a snapshot to one current state + allowed transitions + next action
 * - REVERSE_SYNC_ACTION: canonical reverse-sync action for each state
 *
 * The transition graph (`TRACKER_PR_TRANSITIONS`) is an internal implementation detail.
 * Callers obtain the allowed transitions for a specific state from the
 * `allowedTransitions` field returned by `interpretTrackerPrState`.
 *
 * MVP invariant: one tracker work item -> one GitHub PR.
 *
 * The state machine captures observable facts (tracker item identity, PR lifecycle)
 * and maps them deterministically to exactly one current state, a list of allowed
 * next transitions, a recommended next action, and the canonical reverse-sync action
 * that should be applied to the tracker when entering that state.
 *
 * This snapshot intentionally does not encode tracker-native workflow readiness.
 * Higher-level callers may combine tracker-owned readiness or blocked/done state
 * with this helper when deciding whether PR creation is appropriate.
 *
 * Source-of-truth ownership:
 * - Tracker:        work-item identity, planning hierarchy, and tracker-native state
 * - GitHub:         PR lifecycle, review state, CI/check results, and merge facts
 * - dev-loops:   projection and sync logic only; never the canonical owner of
 *                   business fields
 */

/** Stable state name constants for the tracker-first story-to-PR lifecycle. */
export const TRACKER_PR_STATE = Object.freeze({
  /**
   * No tracker work item was found. Nothing can proceed without a valid
   * tracker item to anchor the PR.
   */
  NO_TRACKER_ITEM: "no_tracker_item",

  /**
   * A tracker work item exists and no PR has been created for it yet.
   * This helper does not infer tracker-native readiness beyond that no-PR
   * execution fact.
   */
  READY_NO_PR: "ready_no_pr",

  /**
   * A draft PR exists for the tracker work item. The tracker should reflect
   * an in-progress state. PR metadata must include the required tracker
   * identifier/link and follow the deterministic title/body projection rules.
   */
  DRAFT_PR_OPEN: "draft_pr_open",

  /**
   * The PR has been marked ready for review (no longer draft). The tracker
   * should reflect a reviewable / in-review state.
   */
  PR_REVIEWABLE: "pr_reviewable",

  /**
   * The PR has been merged. This is the terminal success state. The tracker
   * should be moved to done/completed.
   */
  PR_MERGED: "pr_merged",

  /**
   * The PR was closed without being merged. There is no automatic tracker
   * state transition for this event by default. A human decision is required.
   */
  PR_CLOSED_UNMERGED: "pr_closed_unmerged",

  /**
   * Stop state for ambiguous or contradictory lifecycle snapshots that need
   * an explicit user decision before the workflow can continue.
   */
  BLOCKED_NEEDS_USER_DECISION: "blocked_needs_user_decision",
});

/**
 * Legal transitions for each state.
 * The agent layer selects among allowed transitions; the state machine enforces
 * the graph.
 *
 * Internal implementation detail. Callers receive the allowed transitions for a
 * given state via the `allowedTransitions` field of `interpretTrackerPrState`.
 */
const TRACKER_PR_TRANSITIONS = Object.freeze({
  [TRACKER_PR_STATE.NO_TRACKER_ITEM]: [],
  [TRACKER_PR_STATE.READY_NO_PR]: [TRACKER_PR_STATE.DRAFT_PR_OPEN],
  [TRACKER_PR_STATE.DRAFT_PR_OPEN]: [TRACKER_PR_STATE.PR_REVIEWABLE],
  [TRACKER_PR_STATE.PR_REVIEWABLE]: [
    TRACKER_PR_STATE.PR_MERGED,
    TRACKER_PR_STATE.PR_CLOSED_UNMERGED,
    TRACKER_PR_STATE.DRAFT_PR_OPEN,
  ],
  [TRACKER_PR_STATE.PR_MERGED]: [],
  [TRACKER_PR_STATE.PR_CLOSED_UNMERGED]: [
    TRACKER_PR_STATE.READY_NO_PR,
    TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION]: [],
});

/**
 * Canonical reverse-sync action for each state.
 *
 * Each value names the tracker-side transition that should be applied when
 * the lifecycle enters that state. Adapter implementations map these canonical
 * action names to tracker-native field updates.
 *
 * "none" means no automatic tracker state mutation is required.
 */
export const REVERSE_SYNC_ACTION = Object.freeze({
  [TRACKER_PR_STATE.NO_TRACKER_ITEM]: "none",
  [TRACKER_PR_STATE.READY_NO_PR]: "none",
  [TRACKER_PR_STATE.DRAFT_PR_OPEN]: "set_in_progress",
  [TRACKER_PR_STATE.PR_REVIEWABLE]: "set_reviewable",
  [TRACKER_PR_STATE.PR_MERGED]: "set_done",
  [TRACKER_PR_STATE.PR_CLOSED_UNMERGED]: "none",
  [TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION]: "none",
});

const GATE_REVIEW_VERDICT_SET = new Set(["clean", "findings_present", "blocked"]);

function normalizeSha(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeGateReviewVerdict(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return GATE_REVIEW_VERDICT_SET.has(normalized) ? normalized : null;
}

function hasCleanVisibleCurrentHeadDraftGate(snapshot) {
  return snapshot.prHeadSha !== null
    && snapshot.draftGateCommentVisible
    && snapshot.draftGateCommentVerdict === "clean"
    && snapshot.draftGateCommentHeadSha === snapshot.prHeadSha;
}


function normalizeBooleanLike(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }

    return false;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true" || normalized === "1") {
      return true;
    }

    if (normalized === "false" || normalized === "0" || normalized.length === 0) {
      return false;
    }
  }

  return false;
}

/** Recommended next action for each state. */
const NEXT_ACTIONS = Object.freeze({
  [TRACKER_PR_STATE.NO_TRACKER_ITEM]:
    "Obtain a valid tracker work item before creating a PR",
  [TRACKER_PR_STATE.READY_NO_PR]:
    "If tracker workflow says the item is ready, create a draft PR with required tracker metadata (identifier link, title pattern, body sections, labels)",
  [TRACKER_PR_STATE.DRAFT_PR_OPEN]:
    "Complete development work, run draft gate, post a visible clean current-head draft_gate comment, then mark the draft PR as ready for review",
  [TRACKER_PR_STATE.PR_REVIEWABLE]:
    "Wait for review and CI; merge when approved, or convert back to draft if rework is needed",
  [TRACKER_PR_STATE.PR_MERGED]:
    "Sync tracker item to done/completed terminal state",
  [TRACKER_PR_STATE.PR_CLOSED_UNMERGED]:
    "Report to user; no automatic tracker transition — decide whether to reopen, create a new PR, or close the tracker item",
  [TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION]:
    "Report the blocked state to the user and stop; do not proceed without explicit authorization",
});

/**
 * Normalize a raw tracker-PR snapshot into a validated, canonical snapshot.
 *
 * Unknown or invalid field values are replaced with safe defaults.
 * Throws if `raw` is not a non-null object.
 *
 * Snapshot schema:
 * - trackerItemExists {boolean}      — whether a tracker work item was found
 * - trackerItemId {string|null}      — opaque tracker item identifier (e.g. "PROJ-123")
 * - prExists {boolean}               — whether a GitHub PR exists for this item
 * - prNumber {number|null}           — PR number if known; treat `prNumber` with `prExists=false` as contradictory input
 * - prDraft {boolean}                — whether the PR is in draft state
 * - prMerged {boolean}               — whether the PR has been merged
 * - prClosed {boolean}               — whether the PR is closed on GitHub (merged PRs are also closed)
 * - prHeadSha {string|null}          — current PR head SHA
 * - draftGateCommentVisible {boolean} — whether the draft-gate PR comment is visible on the PR thread
 * - draftGateCommentHeadSha {string|null} — head SHA encoded in the draft-gate PR comment
 * - draftGateCommentVerdict {"clean"|"findings_present"|"blocked"|null} — draft-gate comment verdict
 *
 * @param {object} raw - raw snapshot input
 * @returns {object} normalized snapshot
 */
export function normalizeTrackerPrSnapshot(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Snapshot must be a non-null object");
  }

  const trackerItemExists = normalizeBooleanLike(raw.trackerItemExists);
  const prExists = normalizeBooleanLike(raw.prExists);
  const prNumber =
    typeof raw.prNumber === "number" && Number.isInteger(raw.prNumber) && raw.prNumber > 0
      ? raw.prNumber
      : null;

  return {
    trackerItemExists,
    trackerItemId:
      trackerItemExists && typeof raw.trackerItemId === "string" && raw.trackerItemId.trim().length > 0
        ? raw.trackerItemId.trim()
        : null,
    prExists,
    prNumber,
    prDraft: normalizeBooleanLike(raw.prDraft),
    prMerged: normalizeBooleanLike(raw.prMerged),
    prClosed: normalizeBooleanLike(raw.prClosed),
    prHeadSha: prExists ? normalizeSha(raw.prHeadSha) : null,
    draftGateCommentVisible: normalizeBooleanLike(raw.draftGateCommentVisible),
    draftGateCommentHeadSha: prExists ? normalizeSha(raw.draftGateCommentHeadSha) : null,
    draftGateCommentVerdict: normalizeGateReviewVerdict(raw.draftGateCommentVerdict),
  };
}

/**
 * Interpret a tracker-PR lifecycle snapshot into one current state, allowed
 * next transitions, a recommended next action, and the canonical reverse-sync
 * action for the tracker.
 *
 * Interpretation is deterministic: the same snapshot always yields the same
 * result. The function normalizes the snapshot before interpreting, so raw
 * inputs are accepted.
 *
 * Routing priority:
 * 1. Contradictory snapshot -> blocked_needs_user_decision
 * 2. No tracker item and no PR facts -> no_tracker_item (nothing to anchor a PR to)
 * 3. PR merged -> pr_merged (terminal success)
 * 4. PR closed without merge -> pr_closed_unmerged (terminal, no auto-sync; `prClosed && !prMerged`, even if the closed PR still reports draft)
 * 5. Draft PR exists -> draft_pr_open (in-progress)
 * 6. PR exists and not draft, not merged, not closed -> pr_reviewable
 * 7. Tracker item exists and no PR exists -> ready_no_pr (no-PR execution state)
 *
 * @param {object} snapshot - raw or normalized snapshot
 * @returns {{ state: string, allowedTransitions: string[], nextAction: string, reverseSyncAction: string }}
 */
export function interpretTrackerPrState(snapshot) {
  const s = normalizeTrackerPrSnapshot(snapshot);

  const contradictorySnapshot =
    (!s.trackerItemExists && (s.prExists || s.prNumber !== null || s.prDraft || s.prMerged || s.prClosed)) ||
    (!s.prExists && (s.prNumber !== null || s.prDraft || s.prMerged || s.prClosed)) ||
    (s.prMerged && s.prDraft);

  let state;

  if (contradictorySnapshot) {
    state = TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION;
  } else if (!s.trackerItemExists) {
    state = TRACKER_PR_STATE.NO_TRACKER_ITEM;
  } else if (s.prExists && s.prMerged) {
    state = TRACKER_PR_STATE.PR_MERGED;
  } else if (s.prExists && s.prClosed) {
    state = TRACKER_PR_STATE.PR_CLOSED_UNMERGED;
  } else if (s.prExists && s.prDraft) {
    state = TRACKER_PR_STATE.DRAFT_PR_OPEN;
  } else if (s.prExists) {
    state = hasCleanVisibleCurrentHeadDraftGate(s)
      ? TRACKER_PR_STATE.PR_REVIEWABLE
      : TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION;
  } else {
    state = TRACKER_PR_STATE.READY_NO_PR;
  }

  return {
    state,
    allowedTransitions: [...TRACKER_PR_TRANSITIONS[state]],
    nextAction: NEXT_ACTIONS[state],
    reverseSyncAction: REVERSE_SYNC_ACTION[state],
  };
}
