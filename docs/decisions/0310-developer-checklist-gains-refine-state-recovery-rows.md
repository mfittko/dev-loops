# 0310. The developer checklist gains line C4 (REFINE-STATE-RECOVERY-ROWS)

## Status

Accepted — 2026-11-21 ([issue 3425](https://github.com/mfittko/dev-loops/issues/3425))

Partially amends 0304 ([record](./0304-developer-pre-pr-self-check.md)): the checklist item count of 15 replaces the count of 14. The record stays unedited.

## Context

Record 0304 states that the checklist items of the angles selected for the declared paths number at most 14 with the shipped defaults. Issue 3425 adds line C4 (`REFINE-STATE-RECOVERY-ROWS`) to the `developer-checklist` lines in the shipped config.

## Decision

- The developer checklist has up to 15 items with the shipped defaults. Line C4 (`REFINE-STATE-RECOVERY-ROWS`) is the added item.
- This count replaces the count of 14 in 0304. All other rules of 0304 stay unchanged.

## Consequences

The brief and the record writer require one more evidence entry when the selected angles include the angle that carries C4. The code and contract prose state the count as 15.
