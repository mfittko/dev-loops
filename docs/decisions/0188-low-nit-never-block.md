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
- The durable autonomy principles live in the repo, each as one rule ID in one contract. The judge is the prime authority (`GATE-EXEC-JUDGE-PRIME-AUTHORITY`). For gate-round dispositions, an operator line is needed only where the judge or orchestrator cannot decide or the repo requires human approval, for example approve merge for escalated size (`GATE-EXEC-OPERATOR-LINE-APPROVE-MERGE`) and release tag and publish (`GATE-EXEC-OPERATOR-LINE-RELEASE-PUBLISH`). An ADR replaces a waiver comment (`ADR-OVER-WAIVER`). An issue is split before an oversized PR, at the resolved `softLoc` (`PLAN-SPLIT-BEFORE-OVERSIZE`, `PLAN-SIZE-BAND`). Low and nit findings defer by default (`GATE-EXEC-LOW-NIT-NEVER-BLOCKS`). No fixed fixer-cycle cap exists (`GATE-EXEC-FIXER-CYCLE-BOUND`).
- `GATE-EXEC-LOW-NIT-NEVER-BLOCKS` supersedes `GATE-EXEC-LOW-NIT-CONVERGENCE`: the emitter refuses an all-low/nit act list, so the converged-draft pass cannot start. A legacy ledger with such an `act` recovers by re-running `judge-pass.mjs`, which re-coerces it. See also [ADR 0183](./0183-judge-owns-every-disposition-verdict-and-next-action.md). <!-- secret-scan:allow Relative ADR link; not a credential -->
- Tooling that decides a rule refuses with a typed code that names the rule ID: `low_nit_never_blocks` for `GATE-EXEC-LOW-NIT-NEVER-BLOCKS`.

## Consequences

A round with only low and nit findings composes `clean` and emits no fixer work order. A real low defect is deferred and listed in the verdict unless the judge marks it fail-open.
