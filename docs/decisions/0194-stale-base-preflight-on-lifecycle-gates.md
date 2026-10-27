# 0194. Stale-base preflight on lifecycle gates

## Status

Accepted — 2026-10-26 ([issue 2885](https://github.com/mfittko/dev-loops/issues/2885))

Cites the [gate review sub-loop contract](../../skills/docs/gate-review-sub-loop-contract.md) (`GATE-EXEC-BASE-REFRESH`).

## Context

A gate that reviews a head which lacks commits on the PR base branch reviews a diff that does not match what will merge. `--base` can name any ref, so a check tied to `--base` can be bypassed.

## Decision

- Rule `ADR0194-STALE-BASE-PREFLIGHT`. `write-gate-context` runs a stale-base preflight on every dispatch. It fetches `origin/<PR baseRefName>` and checks that the reviewed head contains it. The check ignores the `--base` value.
- `draft_gate` and `pre_approval_gate` (`GATE-EXEC-BASE-REFRESH`) refuse with `base_stale_integrate_first`, `base_fetch_failed` or `base_head_unresolved` unless the status is `base_current`. A refusal writes no artifact.
- `--gate review` records `baseFreshness` and continues. The review gate has no lifecycle obligation, and a reviewer of a foreign PR cannot rebase.
- `base_unresolved` (the PR base branch cannot be read) refuses on every gate.

## Consequences

A stale lifecycle gate fails closed before an artifact exists. Review artifacts carry the freshness status for the reader.
