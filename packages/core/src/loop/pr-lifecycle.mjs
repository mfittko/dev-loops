/**
 * PR lifecycle: the 13-state vocabulary + required transitions from
 * skills/docs/pr-lifecycle-contract.md (issue #1193), promoted to a real
 * exported contract surface.
 *
 * This is the single source of truth for the family-local PR lifecycle graph:
 * both scripts/pages/build-state-atlas.mjs (site diagram generator) and
 * scripts/docs/validate-state-machine-conformance.mjs (the L2/L3 conformance
 * harness) import this same table, instead of one importing the other's
 * module (which would pull the whole page generator — eager mermaid diagram
 * rendering, duplicate core module instances via relative imports — into the
 * harness's process at load time).
 *
 * Pure data + one derivation, no imports, no side effects.
 */
export const PR_LIFECYCLE_STATES = [
  'draft_local_review_gate',
  'draft_local_remediation',
  'ready_state_needs_copilot_request',
  'waiting_for_copilot_review',
  'copilot_feedback_remediation',
  'copilot_reply_resolve_pending',
  'merge_conflict_resolution',
  'final_local_preapproval_gate',
  'final_gate_remediation',
  'waiting_for_human_pr_approval',
  'waiting_for_merge',
  'terminal_slice_complete',
  'stopped_needs_user_decision',
];

// '[*]' is the synthetic terminal-marker target (see build-state-atlas.mjs's
// renderStateDiagram and validate-state-machine-conformance.mjs's realEdges):
// a row `[state, '[*]']` marks `state` as absorbing without being a real edge.
const TERMINAL_MARKER = '[*]';

export const PR_LIFECYCLE_TRANSITIONS = [
  ['draft_local_review_gate', 'draft_local_remediation'],
  ['draft_local_review_gate', 'ready_state_needs_copilot_request'],
  ['draft_local_review_gate', 'stopped_needs_user_decision'],
  ['draft_local_remediation', 'draft_local_review_gate'],
  ['ready_state_needs_copilot_request', 'waiting_for_copilot_review'],
  ['ready_state_needs_copilot_request', 'stopped_needs_user_decision'],
  ['waiting_for_copilot_review', 'copilot_feedback_remediation'],
  ['copilot_feedback_remediation', 'copilot_reply_resolve_pending'],
  ['copilot_reply_resolve_pending', 'ready_state_needs_copilot_request'],
  ['waiting_for_copilot_review', 'merge_conflict_resolution'],
  ['merge_conflict_resolution', 'waiting_for_copilot_review'],
  ['waiting_for_copilot_review', 'final_local_preapproval_gate'],
  ['final_local_preapproval_gate', 'final_gate_remediation'],
  ['final_local_preapproval_gate', 'waiting_for_human_pr_approval'],
  ['final_gate_remediation', 'final_local_preapproval_gate'],
  ['waiting_for_human_pr_approval', 'waiting_for_merge'],
  ['waiting_for_human_pr_approval', 'draft_local_review_gate'],
  ['waiting_for_merge', 'terminal_slice_complete'],
  ['terminal_slice_complete', TERMINAL_MARKER],
  ['stopped_needs_user_decision', TERMINAL_MARKER],
];

// Derived, not hand-listed (lesson from #1157: a hand-copied terminal list can
// silently drift from the transition table it is supposed to describe). A
// state is terminal when it has zero real (non-marker) outgoing edges.
function deriveTerminalStates(states, transitions) {
  const hasRealOutgoing = new Set(
    transitions.filter(([, to]) => to !== TERMINAL_MARKER).map(([from]) => from),
  );
  return states.filter((state) => !hasRealOutgoing.has(state));
}

export const PR_LIFECYCLE_TERMINAL_STATES = deriveTerminalStates(PR_LIFECYCLE_STATES, PR_LIFECYCLE_TRANSITIONS);

// Enum-style access (SCREAMING_SNAKE_CASE key -> the same state string), so
// handoff scripts can reference `PR_LIFECYCLE_STATE.READY_STATE_NEEDS_COPILOT_REQUEST`
// instead of hardcoding the literal, mirroring the STATE/OUTER_STATE/REVIEWER_STATE
// convention used by the other loop state machines. Derived from PR_LIFECYCLE_STATES
// so a new state cannot be added to one without the other.
export const PR_LIFECYCLE_STATE = Object.freeze(
  Object.fromEntries(PR_LIFECYCLE_STATES.map((state) => [state.toUpperCase(), state])),
);
