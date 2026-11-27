# 0336. The findings log is the only posted-verdict marker, and carry-forward carries whole base units

## Status

Accepted — 2026-11-27 ([issue 3634](https://github.com/mfittko/dev-loops/issues/3634)).

Amends [0314](./0314-gate-rebuild-retires-the-stale-round.md) and [0333](./0333-spec-decision-stop-retires-automatically.md): a fan-in ledger is no verdict marker for the automatic retirement guard. The rest of both records stays unedited.

## Context

Round 5 of the draft gate on the issue 3464 replacement pull request carried link-check and config-drift while contract-surface re-ran. The three angles share one base unit. The context builder packed contract-surface without the carried pair, so the findings-log writer saw a dispatch unit that splits a base unit and refused with no recovery. No findings log was written. The `--rerun-angle` rerun then hit `GATE-EXEC-ROUND-RETIREMENT` because the local fan-in ledger counted as a posted verdict although nothing reached GitHub. The operator approved a retirement.

## Decision

1. `buildCarryForwardPlan` receives base units and the angles this head resolves (`freshAngles`). The units are derived like the writer: `resolveFanoutGroups(config, resolveGateAngleCatalogKey(gate), angles)` over the set the writer will see, which is the angles this head resolves plus the always-re-run angles plus the prior angles that carry. The head's angles are resolved only when the configured base ref resolves and gives a reduced delta. Otherwise the round reruns every angle, no head angle needs resolving, and the units cover the always-re-run angles and the carried prior angles. A prior angle that neither re-runs nor carries is dropped from the set, and `planOverWriterUnits` repeats the plan until the set stops changing. A resolved or always-re-run angle with no prior row is a re-run member of its unit. Resolving the head's angles reads the live `gate:full` label (bounded timeout, fail closed to the labelled pool on any read failure, only a TypeError, ReferenceError or RangeError propagates), the size budget and the base diff, through the context builder's helpers. After the per-angle decisions, every carried angle whose unit has a `mustRerun` member moves to `mustRerun` with reason `base_unit_rerun`. The unit is taken before any cap-split.
2. The split refusal in `recordedUnitError` names the regroup recovery: re-run `resolve-angle-carry-forward.mjs`, `write-gate-context.mjs` and a full `emit-fanout-dispatch.mjs` at this head.
3. `retireStaleRound` treats only a findings log as a posted-verdict marker. The verdict comment renders only from the findings log and `requireFanoutEvidence` refuses a fan-out post without it. A round with a fan-in ledger and no findings log retires automatically on a full re-emission or a changed-bytes rebuild. The retired round's fan-in ledger stays in place: the next `consolidate-fanin.mjs` run removes a stale keyed ledger before it writes the new one. The 0333 skip of the ledger is deleted; its unchanged-bytes trigger stays.

## Consequences

A failed findings-log write needs no operator retirement. A findings log at the head still refuses with the operator `retire-gate-round.mjs` recovery. A carried angle in a group with a re-run angle re-runs, which costs some reviewer work and removes a dead end. Revert by restoring the ledger marker and removing the `baseUnits` pass.
