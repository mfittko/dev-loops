# 0126. Carry-forward strips carried angles from mixed dispatch units

## Status

Accepted — 2026-10-07 ([PR 2686](https://github.com/mfittko/dev-loops/pull/2686))

## Context

Amends [0030](./0030-angle-carry-forward-fail-closed.md): the carry-forward seam stays fail-closed as 0030 defines it. This record only changes how a dispatch unit that mixes carried and uncarried angles is handled. Record 0030 stays unedited.

The reviewer budget preflight excluded a unit only when all its angles were complete or carried. A unit with one carried angle was dispatched whole, so a reviewer re-reviewed an angle that was already carried forward. See [issue 2511](https://github.com/mfittko/dev-loops/issues/2511).

## Decision

Rule `GATE-EXEC-ANGLE-CARRY-FORWARD` now strips carried angles from a mixed dispatch unit in `reviewerBudgetPreflight`.

- A carried angle is removed from the dispatched unit. The reviewer reviews only the uncarried angles.
- A unit left with no angles is dropped from `pendingGroups` and the required reviewer count.
- A mandatory or always-run angle is never carried, so it is never stripped.
- The recorded unit membership stays whole. Stripping affects only what is dispatched.

Rejected alternative: keep dispatching mixed units whole (the status quo, which wastes reviewer budget).

## Consequences

A head-bump re-gate dispatches fewer angles and spends less reviewer budget. The ledger keeps full unit membership, so provenance and reviewer pairing checks are unchanged.
