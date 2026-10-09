# 0134. Retire the review-lineage composition

## Status

Accepted — 2026-10-09 ([PR 2719](https://github.com/mfittko/dev-loops/pull/2719))

## Context

No accepted record introduced the additive review-lineage composition, so this record amends nothing. The composition is Section E of `skills/docs/gate-review-sub-loop-contract.md` and `packages/core/src/loop/review-lineage.mjs`. The module has a builder and no production caller. No gate path ever used it.

## Decision

Remove the review-lineage composition: the module and Section E. `gate-carry-forward.mjs` stays and owns carry-forward. Git history keeps the removed code for recovery.

## Consequences

The contract and the code describe only wired behavior. A future lineage feature starts from a new record and a real caller.
