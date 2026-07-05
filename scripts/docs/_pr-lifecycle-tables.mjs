// PR lifecycle: the 13-state vocabulary + required transitions from
// skills/docs/pr-lifecycle-contract.md.
//
// Pure data, no imports, no side effects: both scripts/pages/build-state-atlas.mjs
// (site diagram generator) and scripts/docs/validate-state-machine-conformance.mjs
// (the L2/L3 conformance harness) import this same table as their single source
// of truth, instead of one importing the other's module (which would pull the
// whole page generator — eager mermaid diagram rendering, duplicate core module
// instances via relative imports — into the harness's process at load time).
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
  ['terminal_slice_complete', '[*]'],
  ['stopped_needs_user_decision', '[*]'],
];
