# 0094. One pre-push reviewer with a bounded delta mode

## Status

Accepted — 2026-09-24 ([issue #2423](https://github.com/mfittko/dev-loops/issues/2423))

Amends [0079](./0079-pre-pr-review-phase.md) and Amends [0085](./0085-pre-pr-review-route-neutral-trigger.md). It keeps full-mode behavior from those records and from [0082](./0082-pre-pr-reviewer-opus.md) unchanged.

## Context

ADR 0079 added a one-time pre-PR review before the first push, with the config role `pre-PR-reviewer`. ADR 0085 made its trigger route-neutral. Neither covers fix pushes inside the gate loop. The 47-round audit on [issue #2268](https://github.com/mfittko/dev-loops/issues/2268) measured 6.3 gate rounds and $47.15 gate cost per PR for PRs with only work-order gate rounds. Most act items in the worked example were fail-closed hardening points in the previous round's own fix. Each one cost a full fan-out round, a judge and a CI run after the push.

## Decision

The role `pre-PR-reviewer` becomes `pre-push-reviewer`, with no alias. The tier key `pre-pr-strong`, the contract path `skills/docs/pre-pr-review-contract.md` and its `PRE-PR-*` rule ids stay unchanged. The role has two modes.

Full mode is the existing pre-first-push review. Its purpose, delivery and budget are unchanged: one fresh reviewer per round, at most two rounds.

Delta mode runs one fresh reviewer after the gate Phase 4 fixer commits a fix for a judge act list and before that fix is pushed. Each delta sequence reviews `reviewBaselineHead..candidateHead`, where the baseline is the head the gate round reviewed. The input carries the heads, the act refs with judge dispositions, the spec identity, the act angles as surface hints and the adversarial checklist; it carries no sibling verdicts and no inlined diff. The reviewer returns a typed `DeltaPrePushReviewResult` and records each widened read. `locally_clear` requires every act item `resolved` and no new finding of severity medium or higher. A sequence runs at most three reviews; a third non-clear review ends `bounded_out`, and the committed candidate is pushed into the normal gate path. A result whose candidate head differs from the worktree head cannot authorize the push. The contract owns these rules as `PRE-PUSH-DELTA-*`. The deterministic checks live in `@dev-loops/core/loop/pre-push-delta-review` behind `dev-loops loop pre-push-delta`.

We rejected a separate role or tier for delta mode, because one role keeps model resolution in one place. We rejected renaming the contract file and its rule ids, because accepted records cite them. We rejected delta sources other than the gate judge's act list, because no other source has a caller-independent definition yet.

## Consequences

A fix-induced regression is caught before its push instead of in the next gate round. The gate stays the authority: a delta result is never gate evidence, a ledger entry, a verdict, a thread or a merge signal, and every pushed fix still gets a full gate round. A sequence adds at most three reviewer calls per gate round. `bounded_out` claims no success. Operators who keyed `.devloops` on `pre-PR-reviewer` must rename the key to `pre-push-reviewer`. `packages/core/test/pre-push-delta-review.test.mjs` and `test/contracts/pre-pr-review-contract.test.mjs` pin the trigger, baseline, input, result, bound, freshness and non-evidence rules.
