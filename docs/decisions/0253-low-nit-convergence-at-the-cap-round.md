# 0253. Low and nit convergence applies at the cap round; the draft gate fixes a low there

## Status

Accepted, 2026-11-05 ([issue 3105](https://github.com/mfittko/dev-loops/issues/3105)).

Amends [ADR 0168](./0168-draft-gate-low-nit-convergence.md) and the draft-gate low deferral of [ADR 0188](./0188-low-nit-never-block.md) (as amended by [ADR 0196](./0196-pre-approval-gate-low-nit-never-block.md)). Every other decision of those records stays in force, and the records stay unedited.

## Context

`GATE-EXEC-LOW-NIT-CONVERGENCE` reads no round count. An all-low/nit act list converges after one fixer pass and a `locally_clear` delta review, so it also fires below the cap and skips the remaining full rounds. At or past the cap, `GATE-EXEC-LOW-FIX-UNTIL-CAP` defers a draft-gate low, so the cap round leaves a low unfixed ([ADR 0251](./0251-soft-round-cap.md) item 6).

## Decision

1. `composeConvergedDraftGate` refuses a round below the cap. Convergence applies at the cap round (completed-round count at or above a positive `gates.draft.maxReviewRounds`) or later. Below the cap a low or nit act list goes to the fixer and the next full round runs.
2. The draft gate fixes a low act item in every round, the cap round included. `resolveDraftRoundCap` returns `lowFixCapped: false` for `draft_gate`. `pre_approval_gate` keeps its low deferral.

## Consequences

A hard cut that only narrows: converged markers already posted stay accepted. A PR that used to converge early on low findings now runs its remaining full rounds, which is the intended use of the cap rounds.
