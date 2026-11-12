# 0268. A recorded per-round bound is the one reviewer-unit angle bound authority

## Status

Proposed

Amends [0095](./0095-single-wave-gate-fanout.md): the reviewer-unit angle bound of 5 becomes the default of a per-round recorded bound, and the packing and pairing text that fixes 5 reads that bound instead. Every other decision of that record stays in force, and the record stays unedited.

Amends [0111](./0111-reviewer-unit-budget-scales-with-diff-size.md): a unit above 5 angles adds a per-angle step to the diff-size budget. The floor, the cap and the diff-size scaling stay in force.

Amends [0072](./0072-emitter-dispatches-autochunk-bundles-grouped.md): the emitter's cap-split and the one-angle split tail follow the recorded bound. The grouped-dispatch default stays in force. <!-- secret-scan:allow ADR file link, not a credential -->

Amends [0071](./0071-review-proportionality-non-overridable-floors.md): a packed unit is one dispatch unit and one reviewer under every proportionality floor. The floors stay non-overridable and no angle is dropped.

## Context

[Issue 3166](https://github.com/mfittko/dev-loops/issues/3166) packs more review angles into each runner for small changes. The five-angle bound `REVIEWER_UNIT_MAX_ANGLES` is enforced in six places: `validateReviewerUnit`, `expandDispatchUnits` and `packDispatchUnits`, the emitter's unit split, the fan-in pairing guard with its preflight tail rule, and the emit-plan tail check. Raising only one of them lets a later stage split the packed unit back to five angles or refuse it as oversized.

## Decision

Each round records its reviewer-unit angle bound as `fanout.unitBound` in the gate-context artifact. `resolveReviewerUnitBound` in `packages/core/src/loop/reviewer-unit-bound.mjs` is the one policy function. The effective bound is the smaller of the requested bound and 10. A missing or invalid value resolves to `REVIEWER_UNIT_MAX_ANGLES` (5), which stays the default.

Every bound consumer reads the recorded value through that function. The emitted plan and the ledger carry `unitBound` when it differs from 5, so the emit-plan tail check and the read path see the same value. The gate-context artifact always records `fanout.unitBound`, including 5. No later stage splits a recorded packed unit back.

A unit above 5 angles gets a per-angle budget step: 9 model turns and 10 tool calls for each angle above 5, added to the diff-size budget and clamped to the existing cap of 95 turns and 100 tool calls. The combined-unit limit is 10 angles. Ten angles and the 9-turn and 10-call step are bounded starting policy values, not measured optima.

Fan-in treats one recorded packed unit as one reviewer. Its angles share one reviewer identity, `countFreshDispatchUnits` counts one unit, and no per-angle reviewer identity is fabricated. A missing, duplicated, foreign or unreported angle, and a blocked record that completes only some angles, still fail closed.

Base units derive at the round's recorded bound on the writer and the read path, so a configured group is never split below the bound. The slice 2 producer MUST derive base units at the round's recorded bound before packing, so a recorded packed unit stays a union of whole base units.

This record covers the bound authority only. It adds no size tier and the producer records 5 until a later record sets another value.

## Consequences

- A consumer that adds a bound check reads `resolveReviewerUnitBound`, never the constant.
- A unit above 5 angles costs a larger budget, bounded by the existing cap.
- Ledgers and plans written before this record carry no `unitBound` and keep the bound of 5.
