# 0220. Coordinator report points replace the mandatory per-phase hand-back

## Status

Accepted — 2026-11-01 ([issue 2955](https://github.com/mfittko/dev-loops/issues/2955), parent [issue 2841](https://github.com/mfittko/dev-loops/issues/2841)).

Supersedes in part [0181](0181-unit-coordinator-handback-boundaries.md): the forced hand-back at the unit boundary and the hard 150K cap. Amends [0187](0187-claude-code-coordinator-report-path.md): the final report no longer includes a hand-back at the first `unitBoundaries.handBackAfter` boundary. The route-derived boundary decision in 0181 and the plain-text pause and output-file read in 0187 still stand. Accepted records remain unchanged.

## Context

ADR 0181 forced a fresh unit coordinator per phase and capped peak input at 150K. The fresh dispatch repeated startup reads and re-derived state that the coordinator already held, and a hard cap gave no room for a run that stays healthy past 150K.

## Decision

- `unitBoundaries.handBackAfter` is renamed `reportAfter`, with the same derivation, ordering, validation and `resume`.
- At a report point the coordinator records status through existing evidence, re-resolves authoritative state and continues. It no longer ends the run.
- 150K peak input is an advisory retrospective diagnostic, not a stop. The rule is `COORDINATOR-CONTINUITY-SOFT-CAP` in the main-agent contract.
- The fresh-dispatch cases stay: a changed route, a stop that needs a caller decision, `final_approval_ready` and terminal completion still end the run and return the final report.

Rejected: keeping the hard cap and only raising its value, because any fixed value repeats the same forced restart.

## Consequences

Coordinators carry context across phases and skip repeated startup reads. Context growth is observed through the advisory diagnostic in retrospectives instead of enforced. The field `handBackAfter` no longer exists. Peak-context compliance remains measured on real runs, and a missing native measurement is reported as unavailable rather than zero.
