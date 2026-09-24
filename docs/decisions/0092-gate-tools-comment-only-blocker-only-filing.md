# 0092. Gate tools post deferred findings as a comment; a runner finding becomes a new issue only when it is a blocker

## Status

Accepted — 2026-09-24 ([issue 2425](https://github.com/mfittko/dev-loops/issues/2425))

Amends [ADR 0051](./0051-net-reduction-disposition-policy.md): that record lets the conductor file a new issue for a deferred finding when no open issue covers it. This record narrows filing further. A runner finding becomes a new issue only when it is a blocker. No tool creates an issue for a deferred finding. The batched comment goes to the linked spec issue or the PR, following the configured tracker. ADR 0051's defer bar for nits and lows is unchanged.

Amends [ADR 0046](./0046-one-review-surface-per-gate-round.md): a gate round still produces one verdict review. The batched deferral comment is an allowed extra surface; it goes on the PR when the PR is the comment target. ADR 0046's body is unchanged.

## Context

During the v1.0.4 drain and the `1.0.4-pre.3` consumer soak, `judge-pass.mjs` and `close-gate-findings.mjs` filed a "Deferred gate findings for <PR>" issue on every defer. The orchestrator's own filing grew the backlog faster than it shrank. Runners skipped `judge-pass` to avoid filing. In a consumer repo whose tracker is not GitHub, `judge-pass` filed a GitHub issue without operator approval.

On PR 2417, fixers fixed judge `act` items without replying to and resolving their gate threads. `close-gate-findings.mjs` selected open threads by severity and round alone, so it defer-closed 11 fixed medium `act` items and filed an issue that was later closed as not planned. That contradicts [ADR 0089](./0089-judge-act-list-drives-review-verdict.md): a judge `act` overrides the medium fix window.

## Decision

- Orchestrator filing. `MAIN-AGENT-FILING-BLOCKER-ONLY` in the main-agent contract: the orchestrator files a new issue from a runner finding only when it blocks a merge or deadlocks a PR. Every other finding goes as a comment on an existing issue or epic.
- Tools never create an issue. `judge-pass.mjs` and `close-gate-findings.mjs` share one comment-only path, `commentDeferredFindings` in `scripts/github/_gate-finding-surface.mjs`. The target is the PR's linked spec issue when `tracker.provider` resolves to `github` and the PR has exactly one closing issue reference. Otherwise the target is the PR itself: no linked issue, more than one closing reference, or a tracker other than GitHub. No tracker other than GitHub is written.
- One comment per tool run. Each run of `judge-pass.mjs` or `close-gate-findings.mjs` posts at most one batched comment on the target, so a round posts at most two. `judge-pass.mjs` posts the judge defers; `close-gate-findings.mjs` posts the severity-based defers, including the operator-visible folded findings. `followUpIssueNumber` in the ledger and `issue=<n>` in the thread marker record the target's number. A finding whose fingerprint the target already lists is not appended again.
- No defer-close of an open act thread. `close-gate-findings.mjs` never selects a thread whose finding the judge disposed `act`, whatever its severity and round. The current round's ledger decides first; on no match there, the prior local ledgers decide, then the thread's rendered judge suffix. An ambiguous prior-ledger result also skips the thread. The fixer replies to every gate thread it fixed or declined on reproduction grounds with the fixing commit or a decline reason, and resolves it before `close-gate-findings.mjs` runs.

Rejected: keeping one "Deferred gate findings" issue per PR (it still grew the backlog and bypassed the configured tracker); writing to a non-GitHub tracker from the gate tools (it needs operator approval per write, which a gate tool cannot obtain).

## Consequences

Deferred findings no longer create backlog items. They stay visible on the spec issue or the PR, where the next reader of that work looks. The net-reduction bar (`isFileableDeferral`) and the judge disposition rules are unchanged; only the filing target changes. A repository on a non-GitHub tracker sees deferrals only on the PR. Existing "Deferred gate findings" issues stay open until an operator triages them. A thread stamped under the old behavior with a different `issue=<n>` fails closed on a retry and needs the fixer or operator to resolve it.
