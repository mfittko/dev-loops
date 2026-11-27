# 0336. The findings log is the only posted-verdict marker, and carry-forward carries whole base units

## Status

Accepted — 2026-11-27 ([issue 3634](https://github.com/mfittko/dev-loops/issues/3634)).

Amends [0314](./0314-gate-rebuild-retires-the-stale-round.md) and [0333](./0333-spec-decision-stop-retires-automatically.md): a fan-in ledger is no verdict marker for the automatic retirement guard. The rest of both records stays unedited.

## Context

Round 5 of the draft gate on the issue 3464 replacement pull request carried link-check and config-drift while contract-surface re-ran. The three angles share one base unit. The context builder packed contract-surface without the carried pair, so the findings-log writer saw a dispatch unit that splits a base unit and refused with no recovery. No findings log was written. The `--rerun-angle` rerun then hit `GATE-EXEC-ROUND-RETIREMENT` because the local fan-in ledger counted as a posted verdict although nothing reached GitHub. The operator approved a retirement.

## Decision

1. `buildCarryForwardPlan` receives the prior round's base units, derived like the writer: `resolveFanoutGroups(config, resolveGateAngleCatalogKey(gate), ledgerAngleNames(perAngle, pool))`. After the per-angle decisions, every carried angle whose unit has a `mustRerun` member moves to `mustRerun` with reason `base_unit_rerun`. Units are disjoint, so one pass suffices. The unit is taken before any cap-split.
2. The split refusal in `recordedUnitError` names the regroup recovery: re-run `resolve-angle-carry-forward.mjs`, `write-gate-context.mjs` and a full `emit-fanout-dispatch.mjs` at this head.
3. `retireStaleRound` treats only a findings log as a posted-verdict marker. The verdict comment renders only from the findings log and `requireFanoutEvidence` refuses a fan-out post without it. A round with a fan-in ledger and no findings log retires automatically on a full re-emission or a changed-bytes rebuild. The 0333 skip of the ledger is deleted; its unchanged-bytes trigger stays.

## Consequences

A failed findings-log write needs no operator retirement. A findings log at the head still refuses with the operator `retire-gate-round.mjs` recovery. A carried angle in a group with a re-run angle re-runs, which costs some reviewer work and removes a dead end. Revert by restoring the ledger marker and removing the `baseUnits` pass.
