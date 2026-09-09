# 0068. Fail closed on incomplete per-fixer thread disposition before the next review round

## Status

Accepted — 2026-09-09 ([issue 1988](https://github.com/mfittko/dev-loops/issues/1988))

## Context

`GATE-EXEC-THREAD-DISPOSITION` (ADR 0045, ADR 0046) already describes how a gate-authored
thread eventually closes across gate rounds. It does not, by itself, guard the narrower boundary
between one fixer PUSH and the next review or gate round: nothing previously asserted that every
thread a fixer's own handoff claims to have tackled actually carried a commit-evidenced reply and a
verified resolution before the loop requested another Copilot review or dispatched another gate
round. PR 1975 exposed the resulting failure at production scale: repeated fixer pushes and
follow-on gate reviews accumulated 47 unresolved threads (44 already outdated) because a push
claimed to address findings while the PR conversation never carried the reply/resolve evidence —
the next review opened over a dirty surface and multiplied obsolete work. This undermines the
`fix → push → reply → resolve → re-review` lifecycle the one-surface/disposition model already
assumes.

## Decision

A new rule, `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY`, closes this gap as a per-fixer fail-closed
boundary distinct from (and sitting beside) `GATE-EXEC-THREAD-DISPOSITION`. The decision itself is
one PURE evaluator, `evaluateFixerDisposition` (`packages/core/src/loop/fixer-disposition.mjs`):
every GitHub/git fact it needs — live thread state, and whether the observed PR head CONTAINS a
claimed fixing commit — is injected as plain data, never fetched inside the evaluator. That is what
lets the same decision run identically across every harness (Pi, Claude Code, Codex) instead of
each harness re-implementing its own judgment. A thread is only in scope when the fixer's own
handoff explicitly marks it `disposition: "tackled"`; every other thread (untackled, deferred,
rejected, foreign-authored, or newly arrived) keeps its existing `GATE-EXEC-THREAD-DISPOSITION`
judgment path untouched. A tackled thread is complete only when its fixing commit is CONTAINED by
the observed PR head (`isCommitContainedByHead`, `scripts/github/_commit-containment.mjs` — a `gh
compare` `identical`/`ahead` status only; a SHA alone, an uncontained SHA, a wrong-branch or
superseded SHA, an API error, or a missing containment fact are all treated as NOT contained), the
thread carries a reply naming that exact commit, and the thread reads resolved on a live re-read —
never on the checkpoint's own claim. `packages/core/src/loop/pr-gate-coordination.mjs` accepts this
result as a `fixerDisposition: { complete, incomplete }` input and, when present and incomplete,
forces a blocked `feedback_resolution` result AHEAD of every lifecycle-state branch — this fires
even when the caller's own `unresolvedThreadCount` reads 0, because bogus or uncontained evidence
must never read as clean. The forbidden-action set this boundary applies
(`FIXER_DISPOSITION_FORBIDDEN_ACTIONS`) is deliberately broader than the existing
`postDraftForbidden` list: it also forbids requesting or re-requesting Copilot review and every
gate-dispatch action, because the failure this closes is specifically the NEXT review round opening
over a dirty surface, not merely a draft/merge transition. `scripts/github/verify-fixer-disposition.mjs`
is the enforcement CLI: it holds a durable checkpoint at
`tmp/gate-findings/<repo-slug>/pr-<N>/fixer-disposition-<headSha>.json`, re-verifies live GitHub
state on every invocation (never trusting the checkpoint's own claim), and is idempotent by
construction — it checks live state before posting any reply, so a restart, a rate limit, a
timeout, or a partial reply-succeeded/resolve-failed run never posts a duplicate evidence reply.

## Consequences

A fixer push that claims to tackle review threads cannot lead to another Copilot review request,
reviewer fan-out, gate dispatch, ready transition, or approval transition while any tackled thread
lacks commit-contained evidence, an evidenced reply, or a verified resolution — the operator-visible
result names every incomplete thread, its expected fixing commit, its failed step, and the only
legal next action. Untackled, deferred, rejected, foreign-authored, and newly arrived threads are
never auto-resolved by this boundary; they keep routing through the existing
`GATE-EXEC-THREAD-DISPOSITION` path. This does not change review angles, severity policy, gate
semantics, or human approval/merge authority, and it does not weaken current-head CI, gate evidence,
review coverage, or merge preconditions — it only adds one additional fail-closed precondition
between a fixer push and the next round.
