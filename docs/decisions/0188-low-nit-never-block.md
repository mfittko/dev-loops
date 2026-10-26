# 0188. Low and nit findings never block a gate round or reach the fixer

## Status

Accepted — 2026-10-26 ([issue 2937](https://github.com/mfittko/dev-loops/issues/2937))

Amends ADR 0183 (judge owns every disposition) for this case only: the judge still disposes every cluster, and severity now floors a `low` or `nit` cluster at `defer` or `reject` unless the judge marks it fail-open. Amends [ADR 0168](./0168-draft-gate-low-nit-convergence.md) for this case only: its trigger (an all-low/nit act list) no longer arises from judge output. The converged-draft machinery stays for legacy ledgers until a later slice removes it. The records that introduced those rules stay unedited.

## Context

In the v1.0.8 drain, lows and nits marked `act` forced extra fixer cycles and gate rounds. One PR needed 12 `draft_gate` and 7 `pre_approval_gate` rounds. Orchestrator briefs added fixed fixer-cycle caps that parked PRs.

## Decision

- `applyJudgeDispositions` coerces a cluster whose members are all `low` or `nit` and whose judge disposition is `act`. A disposition with `failOpen: true` promotes the members to `medium` and keeps `act`. Otherwise an all-`nit` cluster becomes `reject` and a cluster holding a `low` becomes `defer`. A cluster with a `medium`, `high` or `question` member is untouched.
- `emit-fixer-work-order.mjs` refuses an act list that holds only `low` or `nit` items.
- No contract or brief sets a fixed fixer-cycle cap. The bound is a new `high`, size growth past the forecast band, or the closure-only round cap.

## Consequences

A round with only low and nit findings composes `clean` and emits no fixer work order. A real low defect is deferred and listed in the verdict unless the judge marks it fail-open.
