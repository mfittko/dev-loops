# 0162. A fixer work order requires a posted verdict

## Status

Accepted — 2026-10-19 ([issue 2498](https://github.com/mfittko/dev-loops/issues/2498))

## Context

`GATE-EXEC-POST-BEFORE-FIX` in the [gate review sub-loop contract](../../skills/docs/gate-review-sub-loop-contract.md) requires the findings of a gate round to be visible on the PR before the fixer runs. Only prose enforced this rule. The retro of PR 2825 (finding F1) found a fix round that started before the verdict review was posted. `emit-fixer-work-order` emitted the act-list work order without checking the PR.

## Decision

- `emit-fixer-work-order` refuses an act-list work order with `verdict_not_posted` unless the verdict review of the `--gate` gate at `--head-sha` is posted on the PR.
- The check reuses `summarizeGateReviewCommentMarkers`. It does not add a second marker parser.
- A failed read of the posted verdicts refuses with `verdict_not_posted`. The check is fail-closed.
- The refusal names the `dev-loops gate upsert-verdict` command that posts the verdict.
- A work order from the threads source is unaffected.

## Consequences

A fixer cannot start on an act list whose verdict is not on the PR. The emitter enforces `GATE-EXEC-POST-BEFORE-FIX` deterministically.

An act-list emission now reads the PR. A GitHub read failure blocks the fix round until the read succeeds.
