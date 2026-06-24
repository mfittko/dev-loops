# Stop conditions

Canonical owner for agent stop / wait / block conditions across all workflow families.

## Genuine stop conditions

| Condition | Strategy | Behavior |
|---|---|---|
| `blocked` lifecycle state | all | Stop for human decision |
| `done` lifecycle state | all | Terminal stop |
| `approval_ready` without explicit merge auth | `final_approval` | Stop at approval gate |
| `merge_ready` without explicit merge auth | all | Stop at `waiting_for_merge_authorization` |
| Ambiguous / contradictory state | all | Fail closed to `needs_reconcile` |
| Missing authoritative startup inputs | `dev-loop` | Fail closed |

## Non-stop conditions

| Condition | Strategy | Behavior |
|---|---|---|
| `waiting` lifecycle state | `wait_watch` | Healthy wait; re-dispatch from main session |
| `waiting_for_initial_copilot_implementation` | `issue_intake` | Bootstrap wait with 1h watch budget |
| `waiting_for_copilot_review` | `copilot_pr_followup` | Continuation boundary, not completion |
| Quiet watcher observations | `wait_watch` | Observational only, do not surface |

## Cross-references

- [Confirmation rules](confirmation-rules.md)
- [Merge preconditions](merge-preconditions.md)
- [Public Dev Loop Contract](public-dev-loop-contract.md)
