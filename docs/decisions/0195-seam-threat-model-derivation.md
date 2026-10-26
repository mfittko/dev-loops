# 0195. A security-sensitive seam diff never drops the threat-model angle

## Status

Accepted — 2026-10-26 ([issue 2899](https://github.com/mfittko/dev-loops/issues/2899), [operator decision](https://github.com/mfittko/dev-loops/pull/2934#issuecomment-6412941960))

Amends [ADR 0036](./0036-gate-angles-merge-by-name.md): the hard-ceiling rule that a disabled entry is never re-added no longer holds for `threat-model` on a `SECURITY_SENSITIVE_SEAM` diff. The resolver re-adds it past `enabled: false` for the draft and pre-approval gates. Every other angle keeps the hard ceiling.

## Context

The [gate review sub-loop contract](../../skills/docs/gate-review-sub-loop-contract.md) says that a diff touching a `SECURITY_SENSITIVE_SEAM` never drops the `threat-model` angle. Issue 2899 found that the gate dropped it silently. Its non-goal ng:1 kept the seam override on the first draft round only. A `pre_approval_gate` round could then run at a head where no `draft_gate` round had run `threat-model`, and the seam diff got no threat-model review. On PR 2934 the operator chose option A: relax ng:1 and derive the first-round signal from the evidence at the head.

## Decision

- A `SECURITY_SENSITIVE_SEAM` diff never drops the `threat-model` angle.
- Non-goal ng:1 of issue 2899 is relaxed. A `pre_approval_gate` round at a head where no `draft_gate` round ran `threat-model` adds `threat-model` on a seam diff.
- `seamFirstRound` is derived from whether a draft round ran `threat-model` at that head. The source is the `resolvedAngles` of the draft gate-context artifact. A missing or unreadable artifact counts as no run.
- The override applies to the draft and preApproval gates only.
- `resolveGateAngleContract` admits `threat-model` into the draft and preApproval contract pools only. A seam-added record is therefore never foreign to the contract.
- `gates.preApproval.angles` is unchanged.

## Consequences

A seam diff gets at least one threat-model review at each head, from the draft round or else from the pre-approval round. A missing draft artifact errs toward running the angle. The configured pre-approval angle list does not grow, so a non-seam diff runs the same angles as before. Other gates keep their angle pools.
