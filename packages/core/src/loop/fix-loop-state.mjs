/**
 * Deterministic state machine for one gate fix sequence at PR head H (issue 2787, ADR 0166).
 *
 * Shape mirrors `refinement-grill-state.mjs`: a frozen state vocabulary, a frozen
 * transition table, a snapshot normalizer and a pure interpreter. Every fail-closed
 * state has a sanctioned exit, and the conformance harness proves each state reaches
 * a terminal (`full_gate_round` or `stopped`). Evidence follows the head, not the role
 * that made the commit: a foreign commit is the `head_moved` state, not a deadlock.
 */

export const FIX_LOOP_STATE = Object.freeze({
  ACT_PENDING: "act_pending",
  COMMIT_ONLY_EMITTED: "commit_only_emitted",
  NO_COMMIT: "no_commit",
  CANDIDATE_COMMITTED: "candidate_committed",
  DELTA_REVIEW: "delta_review",
  FULL_EMITTED: "full_emitted",
  PUSHED: "pushed",
  CI_RED: "ci_red",
  CI_GREEN: "ci_green",
  DELIVERY_INCOMPLETE: "delivery_incomplete",
  DISPOSITION_COMPLETE: "disposition_complete",
  HEAD_MOVED: "head_moved",
  FULL_GATE_ROUND: "full_gate_round",
  STOPPED: "stopped",
});

const S = FIX_LOOP_STATE;

export const FIX_LOOP_TRANSITIONS = Object.freeze({
  [S.ACT_PENDING]: [S.COMMIT_ONLY_EMITTED],
  [S.COMMIT_ONLY_EMITTED]: [S.CANDIDATE_COMMITTED, S.NO_COMMIT, S.HEAD_MOVED],
  [S.NO_COMMIT]: [S.FULL_GATE_ROUND],
  [S.CANDIDATE_COMMITTED]: [S.DELTA_REVIEW, S.HEAD_MOVED],
  [S.DELTA_REVIEW]: [S.FULL_EMITTED, S.COMMIT_ONLY_EMITTED, S.HEAD_MOVED],
  [S.FULL_EMITTED]: [S.PUSHED, S.HEAD_MOVED],
  [S.PUSHED]: [S.CI_GREEN, S.CI_RED],
  [S.CI_RED]: [S.ACT_PENDING],
  [S.CI_GREEN]: [S.DISPOSITION_COMPLETE, S.DELIVERY_INCOMPLETE],
  [S.DELIVERY_INCOMPLETE]: [S.DISPOSITION_COMPLETE, S.FULL_GATE_ROUND],
  [S.DISPOSITION_COMPLETE]: [S.FULL_GATE_ROUND],
  [S.HEAD_MOVED]: [S.FULL_GATE_ROUND, S.DISPOSITION_COMPLETE],
  [S.FULL_GATE_ROUND]: [],
  [S.STOPPED]: [],
});

const NEXT_ACTIONS = Object.freeze({
  [S.ACT_PENDING]: "Emit a commit_only fixer work order for the act items, unresolved threads or red CI",
  [S.COMMIT_ONLY_EMITTED]: "Wait for the fixer to commit the candidate without pushing",
  [S.NO_COMMIT]: "Close the sequence and remove the push-authority marker, then run a full gate round",
  [S.CANDIDATE_COMMITTED]: "Run the pre-push delta review of the base head to the candidate",
  [S.DELTA_REVIEW]: "Record the delta verdict: clear or bounded_out grants the push, residue re-emits commit_only",
  [S.FULL_EMITTED]: "Push the candidate and confirm the remote head equals it",
  [S.PUSHED]: "Wait for CI to settle on the pushed candidate",
  [S.CI_RED]: "Route the failing checks into a fixer order as a CI-failure source",
  [S.CI_GREEN]: "Run the verifier with --construct, then verify the tool-built report",
  [S.DELIVERY_INCOMPLETE]: "Re-enter delivery with --completion-only at the live head, or run a full gate round",
  [S.DISPOSITION_COMPLETE]: "Run a full gate round on the live head",
  [S.HEAD_MOVED]: "Close the sequence and remove the marker, then run a full gate round on the live head",
  [S.FULL_GATE_ROUND]: "The gate reviews the live head in full",
  [S.STOPPED]: "Operator stop; no further fix actions",
});

const DELTA_VERDICTS = new Set(["clear", "bounded_out", "residue"]);
const CI_STATUSES = new Set(["pending", "green", "red"]);
const REPORT_STATUSES = new Set(["none", "complete", "stale", "superseded"]);

/**
 * @param {object} raw
 * @returns {object}
 */
export function normalizeFixLoopSnapshot(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Snapshot must be a non-null object");
  }
  return {
    stopped: Boolean(raw.stopped),
    // a commit the active order did not make landed (developer, CI fix, base merge, amend)
    headMoved: Boolean(raw.headMoved),
    // the sequence marker was removed and the head is routed on
    sequenceClosed: Boolean(raw.sequenceClosed),
    // a complete checkpoint carries to a descendant head (ahead only)
    dispositionCarried: Boolean(raw.dispositionCarried),
    fullGateStarted: Boolean(raw.fullGateStarted),
    // a posted verdict holds act items, unresolved threads or a red CI result
    actPending: Boolean(raw.actPending),
    markerWritten: Boolean(raw.markerWritten),
    noCommit: Boolean(raw.noCommit),
    candidateCommitted: Boolean(raw.candidateCommitted),
    deltaReviewStarted: Boolean(raw.deltaReviewStarted),
    deltaVerdict: DELTA_VERDICTS.has(raw.deltaVerdict) ? raw.deltaVerdict : null,
    pushGranted: Boolean(raw.pushGranted),
    pushed: Boolean(raw.pushed),
    ciStatus: CI_STATUSES.has(raw.ciStatus) ? raw.ciStatus : "pending",
    reportStatus: REPORT_STATUSES.has(raw.reportStatus) ? raw.reportStatus : "none",
  };
}

/**
 * Interpret one fix-sequence snapshot as exactly one state plus its sanctioned exits.
 *
 * @param {object} snapshot
 * @returns {{state: string, allowedTransitions: string[], nextAction: string, reason: string|null}}
 */
export function interpretFixLoopState(snapshot) {
  const s = normalizeFixLoopSnapshot(snapshot);
  let state;
  let reason = null;

  if (s.stopped) {
    state = S.STOPPED;
  } else if (s.fullGateStarted) {
    state = S.FULL_GATE_ROUND;
  } else if (s.headMoved) {
    if (s.dispositionCarried) {
      state = S.DISPOSITION_COMPLETE;
      reason = "descendant_carry";
    } else {
      state = s.sequenceClosed ? S.FULL_GATE_ROUND : S.HEAD_MOVED;
    }
  } else if (s.noCommit) {
    state = s.sequenceClosed ? S.FULL_GATE_ROUND : S.NO_COMMIT;
  } else if (s.pushed) {
    if (s.ciStatus === "red") state = S.CI_RED;
    else if (s.ciStatus === "pending") state = S.PUSHED;
    else if (s.reportStatus === "complete") state = S.DISPOSITION_COMPLETE;
    else if (s.reportStatus === "none") state = S.CI_GREEN;
    else state = S.DELIVERY_INCOMPLETE;
  } else if (s.pushGranted) {
    state = S.FULL_EMITTED;
  } else if (s.candidateCommitted) {
    if (s.deltaVerdict === "residue") {
      state = S.COMMIT_ONLY_EMITTED;
      reason = "delta_residue";
    } else {
      state = s.deltaReviewStarted ? S.DELTA_REVIEW : S.CANDIDATE_COMMITTED;
    }
  } else if (s.markerWritten) {
    state = S.COMMIT_ONLY_EMITTED;
  } else {
    // ponytail: nothing to fix and no open sequence is the full-gate fallback authority.
    state = s.actPending ? S.ACT_PENDING : S.FULL_GATE_ROUND;
  }

  return { state, allowedTransitions: [...FIX_LOOP_TRANSITIONS[state]], nextAction: NEXT_ACTIONS[state], reason };
}
