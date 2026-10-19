# 0163. Same-head validation artifact reuse across lifecycle gates

## Status

Accepted — 2026-10-19 ([issue 2508](https://github.com/mfittko/dev-loops/issues/2508))

## Context

Amends [0137](./0137-validation-modes-and-consumer-configured-commands.md): it decided that `dev-loops gate resolve-validation` runs the declared suites for each gate round. The `draft_gate` and the `pre_approval_gate` each re-ran full validation at the same head. This cost 3.2 minutes per PR on PRs 2824 and 2825. Record 0137 stays unedited.

## Decision

- `gate resolve-validation` reuses another lifecycle gate's validation artifact only on the `package.json` verify path.
- Reuse needs an exact match on all of: repo, PR, head SHA, profile, toolchain, suite list and PR title.
- A reused artifact is stamped `reusedFrom: <gate>`. On chained reuse the stamp keeps the original gate (`prior.reusedFrom ?? gate`).
- The review gate never reuses.
- `ci-only` mode and the declared `validation.fullCommand` path never reuse.
- A failed, incomplete or mismatched artifact never reuses. The suites run as before.
- `GATE-EXEC-VALIDATION-RESOLUTION` in the [gate review sub-loop contract](../../skills/docs/gate-review-sub-loop-contract.md) records the rule.

## Consequences

One gate's validation artifact satisfies another gate's validation for the same head. This removes the duplicate full run.

Evidence stays traceable through `reusedFrom`. The artifact keeps its shape plus that one field.

A changed PR title or a new head forces a real run.
