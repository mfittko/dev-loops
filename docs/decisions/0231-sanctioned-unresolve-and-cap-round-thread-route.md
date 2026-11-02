# 0231. A sanctioned unresolve wrapper and the thread route at the Copilot round cap

## Status

Accepted — 2026-11-02

## Context

Issue [2577](https://github.com/mfittko/dev-loops/issues/2577) tracks the decline-and-resolve path at the Copilot round cap. On PR [3017](https://github.com/mfittko/dev-loops/pull/3017) the coordinator declined two Copilot threads and resolved them. The thread-route fixer then refused to start. `emit-fixer-work-order.mjs --threads-file` accepts only unresolved threads. The raw unresolve mutation is denied by `COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER`, so no agent path could reopen the threads.

## Decision

- `scripts/github/unresolve-review-thread.mjs` is the sanctioned unresolve wrapper. It refuses with `thread_not_resolved`, `thread_not_on_pr`, `pr_closed_or_merged` and `thread_author_not_reviewer`. The Claude Code Bash hook allows the script only for the main agent and the dev-loop coordinator. It denies every other agent type. The raw unresolve mutation stays denied, and the denial names the script.
- `GATE-EXEC-ROUND-CAP-NO-DECLINE-RESOLVE` in `skills/docs/gate-review-sub-loop-contract.md` governs the Copilot round cap. The rule routes a high or medium finding through the thread route instead of a decline and resolve. It lets a low finding be deferred with a follow-up issue number. It keeps a body-only disposition as an operator-owned line. The `emit-fixer-work-order.mjs` refusal for resolved threads names the unresolve script.
- The convergence carry-forward already held. A fix commit on a final-round head that carries a current-head `changes_recommended` review gives `no_current_head_review` with disposition `converged_once`. A `merge-pr` test pins this case, and `skills/docs/merge-preconditions.md` states it.

## Consequences

No agent and no operator unresolves a thread by hand in the GitHub UI to unblock the fixer. The role restriction is enforced only by the Claude Code hook. Pi does not restrict the script for non-read-only roles.
