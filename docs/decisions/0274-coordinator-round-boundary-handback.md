# 0274. A coordinator hands back at the end of every gate round and every fix pass

## Status

Accepted — 2026-11-15 ([issue 3069](https://github.com/mfittko/dev-loops/issues/3069)).

Supersedes in part [0220](0220-coordinator-report-points-replace-per-phase-handback.md): the decision that a coordinator continues at a report point such as `gate_verdict_posted`. Amends [0181](0181-unit-coordinator-handback-boundaries.md). Accepted records remain unchanged.

## Context

ADR 0220 let a unit coordinator continue past a report point. A long run then carried gate and fix-pass context into later rounds and grew without a bound.

## Decision

A unit coordinator hands back at the end of every gate round and at the end of every fix pass (`COORDINATOR-ROUND-BOUNDARY-HANDBACK` in `skills/docs/main-agent-contract.md`). It never continues into the next round. The hand-back is a typed packet, and a fresh coordinator re-resolves state from GitHub. The 150K soft cap from ADR 0181 stays advisory.

## Consequences

- At `gate_verdict_posted` the coordinator ends the run. ADR 0220 no longer decides this case.
- The route-derived boundary decision in ADR 0181 still stands.
