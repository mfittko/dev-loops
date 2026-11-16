# 0284. Stale-base preflight in validation and verdict seams

## Status

Accepted — 2026-11-16 ([PR 3230](https://github.com/mfittko/dev-loops/pull/3230)).

Extends [ADR 0096](0096-integrate-base-before-every-gate-round.md). Amends the `GATE-EXEC-BASE-REFRESH` paragraph in the [gate review sub-loop contract](../../skills/docs/gate-review-sub-loop-contract.md). Slice 2b of [issue 2885](https://github.com/mfittko/dev-loops/issues/2885).

## Context

ADR 0096 requires the loop to integrate the base branch before every gate round. Nothing enforced that rule at the seams that produce the evidence. A head behind its base could still record a validation result and post a clean verdict. The result then described a tree that no longer matched the merge target.

## Decision

1. `gate resolve-validation` and `loop validation-record` run the stale-base preflight. At a stale head they return an incomplete result and record no passing validation.
2. `upsert-verdict` and `pr reconcile-draft` run the same preflight before a clean verdict posts. At a stale head they refuse with `base_stale_integrate_first`.
3. The validation seams check the default branch that `origin/HEAD` names. The verdict seams check the PR base, because the PR base decides what the merge produces.
4. Only a clean verdict is refused. A verdict that reports findings still posts, because it does not approve the head.

## Consequences

- A stale head cannot record passing validation or post a clean verdict. The remedy is to integrate the base and rerun the gate round.
- The two seam families can disagree when a PR targets a branch other than the default branch. Each family checks its own base by design.
- The preflight adds one git comparison to each seam. It needs a fetched `origin` ref, so a missing ref fails closed.
