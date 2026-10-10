# 0131. Pre-push delta gains a thread route and a decision record

## Status

Accepted — 2026-10-07 ([issue #2575](https://github.com/mfittko/dev-loops/issues/2575))

Amends: 0094 ([record](./0094-pre-push-reviewer-delta-mode.md)). It keeps the delta statuses, outcomes, the three-invocation bound and the act-list trigger unchanged.

## Context

ADR 0094 added delta mode for fixes of the judge act list and rejected other delta sources "because no other source has a caller-independent definition yet". Nothing enforced the order commit, delta review, push. A `--phase full` fixer order carried act-list fixes with no delta review. A Copilot-thread fix reached the remote after a `needs_fix` delta review, and its thread was replied to as fixed and resolved. The `--result` run printed its decision to stdout only, so no later step could see it. See [issue 2575](https://github.com/mfittko/dev-loops/issues/2575).

## Decision

The thread route is a second delta source. The captured set of unresolved review threads (`list-review-threads --unresolved-only` output for the PR) is its caller-independent definition. `check-pre-push-delta.mjs --threads-file` turns each unresolved thread into one act item whose `ref` is the `threadId`. The baseline, `actSetId`, result shape and invocation bound match the act-list route. `resolveDeltaTrigger` takes a thread item count next to the act item count.

`check-pre-push-delta.mjs --result` records its decision at `<tmp-root>/gate-delta/<reviewBaselineHead>.json`. The record is local evidence. No gate verdict, findings ledger, comment or merge signal reads it (PRE-PUSH-DELTA-NOT-GATE-EVIDENCE).

Two consumers read the record.

- `emit-fixer-work-order.mjs` refuses `--phase full` without a clearing decision for the PR head. An act-list source needs a clearing `--delta-result`. A threads source needs a thread-bound record with `nextStep` `push` or `push_to_gate`. A record with another `nextStep` refuses either source. The refusal names `commit_only`.
- The fixed-reply guard in `_review-thread-mutations.mjs` refuses a fixed reply for a thread that a covering record marks `not_resolved` or `cannot_verify`. `reply-resolve-review-thread.mjs`, `reply-resolve-review-threads.mjs` and `verify-fixer-disposition.mjs` call it.

Related boundary: `request-copilot-review.mjs` does not read the record. It refuses while the fixer disposition is incomplete, and the shared resolver reports `not_verified` when a delivered tackled handoff for the live head has no verification checkpoint.

Rejected alternative: an operator bypass flag for the full-phase refusal. The `bounded_out` exit already yields `push_to_gate`.

## Consequences

An absent record means "no delta decision" on the act-list and reply paths. The thread route is the one new refusal on an absent record. Old and new checkouts pair safely, because the emitter and the checker both run from the caller's checkout. Pushes outside a fixer work order stay under the coordinator ceilings of ADR 0080 until a separate decision extends the push wrapper. `test/loop/emit-fixer-work-order.test.mjs`, `test/loop/check-pre-push-delta.test.mjs`, the reply and verify tests, and `test/contracts/pre-pr-review-contract.test.mjs` pin these rules.
