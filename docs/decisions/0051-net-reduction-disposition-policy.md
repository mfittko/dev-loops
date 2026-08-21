# 0051. Net-reduction disposition policy: reject bar for nits and lows, append-first deferrals

## Status

Accepted — 2026-08-21 ([PR 1799](https://github.com/mfittko/dev-loops/pull/1799))

Re-scopes the judge's `defer` disposition from [the Phase 3.5 judge contract](../../skills/docs/gate-review-sub-loop-contract.md); the soft-cap contract's mechanism (every `defer` carries a `followUpDraft`, validated fail-closed) is unchanged. Relates to [ADR 0045](./0045-thread-disposition-replaces-survivor-filing.md): that record replaced automated survivor filing with thread disposition, and this record now also bounds when the conductor files an issue by hand, closing the manual half of the same growth channel.

## Context

Through August 2026 the gate loop was net-adding backlog. One session (2026-08-20/21) closed 4 issues and opened 17: every judge `defer` produced a new issue because the conductor filed each `followUpDraft` verbatim, fresh-context reviewers reliably produce low/nit findings on any diff (a 5-line PR collected 6 findings across its gates), and gate-infrastructure PRs generate third-generation polish churn about the gate infrastructure itself. The operator reviewed the ledger and adopted a net-reduction policy in-session (operator instruction, 2026-08-21, recorded in the PR that carries this record), alongside a one-time authorized triage that closed ten nit-grade issues as not planned.

## Decision

The judge's defer bar is deliberately high. A `nit` never receives a verdict `disposition` of `defer`: its only judge dispositions are `act` (when it rides an already-planned fix pass) or `reject`, and its resolved thread note is its only record. A `low` is deferred only when leaving it unfixed would change an operator-visible outcome — wrong guidance a conductor executes, a fail-closed gap reachable on a sanctioned path, or a demonstrable bug; an unfixed `low` clearing none of those defaults to `reject`, and the rationale names the bar it failed rather than a fabricated non-goal. Coverage resolution is the conductor's job: before filing any `followUpDraft`, the conductor checks the open issues (via `list-issues.mjs`) and appends a comment to a covering issue (via `comment-issue.mjs`) instead of filing a new one (via `create-issue.mjs`); the judge titles a draft `Append to issue N: ...` when its briefing already names a covering issue. A new issue is warranted only when no open issue covers the territory. We rejected loosening the followUpDraft requirement itself (the durable record of conscious deferral stays) and rejected suppressing low/nit findings at the reviewer layer (reviewers keep reporting; the disposition layer is where relevance lives).

## Consequences

Deferrals stop manufacturing backlog: most soft findings end as rejected thread notes, and the ones worth tracking accumulate on existing issues instead of fragmenting into new ones. The judge's rationale field carries the defer-bar basis, so a below-the-bar reject is auditable in the ledger. The trade-off is deliberate information loss: a rejected nit has no issue-tracker record beyond its resolved thread, and a future reader who wants it back must re-find it — accepted, because a reviewer with fresh context re-finds anything that still matters. Operators drain the remaining stock with periodic authorized triage sweeps and batch polish PRs rather than one-issue-per-finding bookkeeping.
