# 0222. At the Copilot round cap, gate coordination routes by CI state and threads

## Status

Accepted, 2026-11-01 ([issue 3002](https://github.com/mfittko/dev-loops/issues/3002)).

## Context

[ADR 0012](./0012-copilot-round-cap.md) set the Copilot round cap (`maxCopilotRounds`). [ADR 0185](./0185-draft-gate-round-cap-and-post-convergence-no-code-commit.md) set the draft_gate round cap that the cap-round proof depends on. [ADR 0208](./0208-draft-cap-round-fixed-goes-ready.md) made the cap round's fixer pass the last draft step. At the cap, gate coordination returned `report_blocked` with no remedy when the run_pre_approval_gate grant did not hold. A PR with pending CI or unresolved threads then had no legal next action. A rebased cap-round baseline also left no clearing record that could bind to the head.

## Decision

Rule `GATE-EXEC-ROUND-CAP-THREAD-ROUTE` in `skills/docs/gate-review-sub-loop-contract.md` governs the cap states when the grant does not hold:

1. Required CI `pending` or `none` returns `wait_for_ci`.
2. Unresolved threads return the thread route (`unresolved_feedback`, allowing `address_review_feedback` and `reply_resolve_review_threads`) and forbid `request_copilot_review` and `rerequest_copilot_review`. No new Copilot cycle is legal past the cap.
3. Required CI `failure` or `crediblyGreen` with zero unresolved threads returns `report_blocked` with a reason that names `round_cap_reached`, the head SHA, the CI state and a runnable remedy.
4. Every other state returns `report_blocked` with a reason that names the state and one instruction: re-resolve with `loop startup --pr <n>`.

The `baseline_orphaned` refusal holds when the cap-round head is not an ancestor of the head. It names the replacement-PR restart: push to a new branch, record a pre-PR review, run `pr create --allow-replacement-pr`, then close the old PR. Gate history restarts at round 1.

No cap value or merge precondition changes. ADR 0185 and ADR 0208 stay in force.

## Consequences

A PR at the cap always has a named next action. Failing CI no longer blocks the thread route. Operators who rebase a cap-round PR receive the replacement-PR instruction, and the contract tells them to merge the base instead of rebasing.
