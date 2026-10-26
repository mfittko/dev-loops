# 0188. Fix lows until the draft-gate round cap; nits never block

## Status

Accepted — 2026-10-26 ([issue 2937](https://github.com/mfittko/dev-loops/issues/2937))

Amends ADR 0183 (judge owns every disposition) for this case only: the judge still disposes every cluster, and severity floors a `nit` cluster at `reject` from draft round 2 on (a nit may be fixed in round 1, operator amendment 2026-10-26), and a `low` cluster at `defer` at or past the draft-gate round cap (ADR 0185), unless the judge marks it fail-open. Amends [ADR 0168](./0168-draft-gate-low-nit-convergence.md) for this case only: its trigger (an all-low/nit act list) arises again only below the round cap, because at or past the cap the judge output and the emitter exclude it. Amends [ADR 0185](./0185-draft-gate-round-cap-and-post-convergence-no-code-commit.md) for the past-cap low/nit case only: a past-cap round whose act items are all low or nit follows `GATE-EXEC-LOW-FIX-UNTIL-CAP` instead of converging by ADR 0168. The records that introduced those rules stay unedited.

## Context

In the v1.0.8 drain, lows and nits marked `act` forced extra fixer cycles and gate rounds. One PR needed 12 `draft_gate` and 7 `pre_approval_gate` rounds. Orchestrator briefs added fixed fixer-cycle caps that parked PRs.

## Decision

- `applyJudgeDispositions(findings, verdict, { pastCap, round })` coerces a cluster whose members are all `low` or `nit` and whose judge disposition is `act`. A disposition with `failOpen: true` promotes the members to `medium` and keeps `act` in every round. Otherwise an all-`nit` cluster stays `act` in draft round 1 below the cap and becomes `reject` from round 2 on (and at the cap). `pre_approval_gate` has no round count, so it is never round 1 and its nit `act` is rejected. A cluster holding a `low` (its nit members ride along, one disposition per cluster) stays `act` below the cap and becomes `defer` at or past it. A cluster with a `medium`, `high` or `question` member is untouched. Operator decision 2026-10-26: fix lows until the cap.
- `emit-fixer-work-order.mjs` refuses an act list that holds only `low` or `nit` items at or past the draft_gate cap, and an act list of only `nit` items outside draft round 1 (a hand-built nit-only list in round 2 or later below the cap stays refused). A nit-only list passes in draft round 1. The cap state and round number come from one resolver, `resolveDraftRoundCap`, over the ADR 0185 round count.
- No contract or brief sets a fixed fixer-cycle cap. The bound is a new `high`, size growth past the forecast band, or the closure-only round cap.
- The durable autonomy principles live in the repo, each as one rule ID in one contract. The judge is the prime authority (`GATE-EXEC-JUDGE-PRIME-AUTHORITY`). For gate-round dispositions, an operator line is needed only where the judge or orchestrator cannot decide or the repo requires human approval, for example approve merge for escalated size (`GATE-EXEC-OPERATOR-LINE-APPROVE-MERGE`) and release tag and publish (`GATE-EXEC-OPERATOR-LINE-RELEASE-PUBLISH`). An ADR replaces a waiver comment (`ADR-OVER-WAIVER`). The fixer fixes lows until the round cap and a nit is fixed in draft round 1 and rejected from round 2 on (`GATE-EXEC-LOW-FIX-UNTIL-CAP`). No fixed fixer-cycle cap exists (`GATE-EXEC-FIXER-CYCLE-BOUND`).
- `GATE-EXEC-LOW-NIT-CONVERGENCE` stays reachable below the cap, where an all-low/nit act list can again occur. At or past the cap `GATE-EXEC-LOW-FIX-UNTIL-CAP` keeps such a list from the fixer. A legacy ledger with such an `act` past the cap recovers by re-running `judge-pass.mjs`, which re-coerces it from the cluster each finding projects into (computed from the original severities, so an unstamped ledger coerces like a stamped one). See also [ADR 0183](./0183-judge-owns-every-disposition-verdict-and-next-action.md). <!-- secret-scan:allow Relative ADR link; not a credential -->
- Tooling that decides a rule refuses with a typed code that names the rule ID: `low_fix_until_cap` for `GATE-EXEC-LOW-FIX-UNTIL-CAP`.

## Consequences

Below the cap a real low is fixed. At or past the cap a round with only low and nit findings composes `clean` and emits no fixer work order, and a real low defect is deferred and listed in the verdict unless the judge marks it fail-open.
