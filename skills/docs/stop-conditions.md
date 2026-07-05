# Stop conditions

Canonical owner for agent stop / wait / block conditions across all workflow families.

## Terms

| Term | Definition |
|---|---|
| <!-- term: state:blocked --> `blocked` | Lifecycle state requiring a human decision before the loop continues. |
| <!-- term: state:done --> `done` | Terminal lifecycle state. |
| <!-- term: state:approval_ready --> `approval_ready` | Lifecycle state where approval evidence is ready but merge authorization is not implied. |
| <!-- term: state:merge_ready --> `merge_ready` | Lifecycle state where merge preconditions are ready to evaluate. |
| <!-- term: state:waiting --> `waiting` | Lifecycle state for healthy external waits. |
| <!-- term: state:waiting_for_initial_copilot_implementation --> `waiting_for_initial_copilot_implementation` | Bootstrap wait state for the first Copilot PR. |
| <!-- term: state:waiting_for_copilot_review --> `waiting_for_copilot_review` | Copilot review-settle wait state for the current head. |
| <!-- term: state:waiting_for_merge_authorization --> `waiting_for_merge_authorization` | Stop state for merge-ready work without explicit merge authorization. |
| <!-- term: reason:needs_reconcile --> `needs_reconcile` | Reconcile reason for ambiguous, contradictory, or unsupported state. |

## Genuine stop conditions

| Rule ID | Condition | Strategy | Behavior |
|---|---|---|---|
| <!-- rule: STOP-BLOCKED-001 --> `STOP-BLOCKED-001` | `blocked` lifecycle state | all | The loop MUST stop for a human decision. |
| <!-- rule: STOP-DONE-001 --> `STOP-DONE-001` | `done` lifecycle state | all | The loop MUST treat the state as terminal. |
| <!-- rule: STOP-APPROVAL-001 --> `STOP-APPROVAL-001` | `approval_ready` without explicit merge authorization | `final_approval` | The loop MUST stop at the approval gate. |
| <!-- rule: STOP-MERGE-AUTH-001 --> `STOP-MERGE-AUTH-001` | `merge_ready` without explicit merge authorization | all | The loop MUST stop at `waiting_for_merge_authorization`. |
| <!-- rule: STOP-HUMAN-MERGE-001 --> `STOP-HUMAN-MERGE-001` | `autonomy.humanMergeOnly: true` | all | The loop MUST stop at merge for human action even with explicit merge authorization; the agent MUST NOT run `gh pr merge` (see [Merge preconditions](merge-preconditions.md)). |
| <!-- rule: STOP-RECONCILE-001 --> `STOP-RECONCILE-001` | Ambiguous or contradictory state | all | The loop MUST fail closed to `needs_reconcile`. |
| <!-- rule: STOP-STARTUP-INPUTS-001 --> `STOP-STARTUP-INPUTS-001` | Missing authoritative startup inputs | `dev-loop` | The loop MUST fail closed. |

## Non-stop conditions

| Rule ID | Condition | Strategy | Behavior |
|---|---|---|---|
| <!-- rule: STOP-WAIT-001 --> `STOP-WAIT-001` | `waiting` lifecycle state | `wait_watch` | The loop MUST treat this as a healthy wait and re-dispatch from the main session. |
| <!-- rule: STOP-INITIAL-COPILOT-001 --> `STOP-INITIAL-COPILOT-001` | `waiting_for_initial_copilot_implementation` | `issue_intake` | The loop MUST use the bootstrap wait with a one-hour watch budget. |
| <!-- rule: STOP-COPILOT-REVIEW-001 --> `STOP-COPILOT-REVIEW-001` | `waiting_for_copilot_review` | `copilot_pr_followup` | The loop MUST treat this as a continuation boundary, not completion. |
| <!-- rule: STOP-QUIET-WATCHER-001 --> `STOP-QUIET-WATCHER-001` | Quiet watcher observations | `wait_watch` | The loop MUST treat quiet observations as observational only and MUST NOT surface them as stops by themselves. |

## Cross-references

- [Confirmation rules](confirmation-rules.md)
- [Merge preconditions](merge-preconditions.md)
- [Public Dev Loop Contract](public-dev-loop-contract.md)
- [Contract style guide](contract-style-guide.md)
