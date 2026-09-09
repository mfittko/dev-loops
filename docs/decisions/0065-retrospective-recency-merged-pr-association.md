# 0065. Scope retrospective recency to merged-PR association; accept a nullable-strategy terminal reconciliation envelope

## Status

Accepted — 2026-09-09 ([issue #2027](https://github.com/mfittko/dev-loops/issues/2027), [PR 2097](https://github.com/mfittko/dev-loops/pull/2097))

Reverses the recency-derivation half of the `RETRO-CHECKPOINT-CYCLE-SCOPED` rule in `skills/docs/retrospective-checkpoint-contract.md` (no prior ADR owned it). The cycle-scoping principle — a `complete`/`skipped` checkpoint discharges exactly one qualifying completion, derived fresh at read time — is unchanged; only the definition of "a newer cycle exists" changes.

## Context

`RETRO-CHECKPOINT-CYCLE-SCOPED` derived recency as a purely local git fact: `git log <mergeCommit>..origin/<baseBranch>` non-empty meant "something merged since, so the checkpoint is stale." That prior text deliberately argued against any GitHub query. In a squash-merging repo that also carries direct base-branch commits (release stamps, reverts), the rule over-fires: any direct commit after the checkpoint marks it stale, so a valid completed retrospective is reported `needs_reconcile` even though no new PR cycle occurred. Observed live after PR #2019: a later direct release commit falsely blocked issue #2027's own startup — a bootstrap dead end, since the mandatory handoff-envelope step could not even represent the stop (`buildDevLoopHandoffEnvelope` rejected the router's `needs_reconcile` / null-strategy result).

## Decision

Retrospective recency means "a newer PR merged into the configured base branch," not "the base branch has any newer commit" and not "git history has a two-parent merge." `resolveHasNewerMergeSinceCheckpoint` keeps the best-effort base refresh and adds a `merge-base --is-ancestor` guard (a non-ancestor/unresolvable checkpoint fails closed), bounds candidate commits with `git rev-list <mergeCommit>..origin/<baseBranch>`, and classifies each candidate via the authoritative GitHub `Commit.associatedPullRequests` GraphQL connection. A candidate makes the checkpoint stale only when a `MERGED` PR has `base.ref === baseBranch` AND `merge_commit_sha === candidate`. Direct commits, releases, tags, open/closed-unmerged PRs, and PRs merged into another base do not. The checkpoint identity's `repo` must exactly match the auto-detected current repo before any lookup; a foreign or unresolvable identity, a malformed/failed association lookup, and a paginated response that cannot be fully verified all fail closed to `missing`.

Separately, `buildDevLoopHandoffEnvelope` and `validateHandoffEnvelope` accept the router's intentional terminal reconciliation tuple — `routeKind: needs_reconcile`, `selectedGate: fail_closed_reconcile`, `selectedStrategy: null` — and emit an actionable reconciliation envelope (no worktree required, `stopRules: ["reconcile"]`, a required reconcile acceptance criterion). This is not a gate exemption: routed strategies still require a non-empty strategy, and the tuple is accepted only when every marker agrees.

## Consequences

The fail-closed posture is preserved and strengthened: uncertainty (unverifiable ancestry, foreign/unresolvable repo identity, unavailable or malformed association facts, exhausted pagination) still resolves to `missing`/`needs_reconcile`. Recency now depends on a bounded, best-effort GitHub read gated on `workflow.requireRetrospective`; a repo that does not opt in performs no association lookup. The documented startup-to-envelope path is unblocked end to end. The contract prose (`retrospective-checkpoint-contract.md`, `public-dev-loop-contract.md`, `workflow-handoff-contract.md`) and generated `.claude/` mirrors are updated in lockstep, and regression coverage pins each classification and fail-closed branch plus the terminal-envelope tuple.
