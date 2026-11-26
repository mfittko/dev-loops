# 0327. Delete the non-convergence brake

## Status

Accepted — 2026-11-26 ([issue 3582](https://github.com/mfittko/dev-loops/issues/3582), folds [issue 3590](https://github.com/mfittko/dev-loops/issues/3590)); operator mfittko, ask tool.

Amends [0322](./0322-cap-brakes-and-the-scoped-final-round.md): clause (2), the non-convergence brake, is deleted. Amends decision 5 of [0332](./0332-body-only-exit-at-any-draft-round.md): the skip has no stop to skip. ADR 0322 and ADR 0332 stay unedited. [0329](./0329-direct-focus-file-clears-cap-brake-stops.md) stays in force for the remaining stops.

## Context

The brake stopped a lane when a judged round had at least as many act items as the round before it. It compared raw counts of act clusters, lows and nits included. A raw count cannot tell a new, smaller defect from a defect that was not fixed. Three lanes stopped while converging: PR 3580 (2 then 3 low items, no shared fingerprint), a consumer repository draft_gate (2 then 2) and the issue 3611 pull request pre_approval_gate (1 then 1). Each needed an operator focus decision.

No sound replacement exists. The act fingerprint is a hash of the first file path and the normalized reviewer summary, and fresh reviewers word a recurring defect differently. In the local gate ledgers, 1423 consecutive same-gate round pairs have act items in the earlier round. The count rule stops 325 of them. An identical act fingerprint recurs in 7. A shared file appears in 693 and a shared file:line in 179, so a looser key stops more lanes than the count rule.

The round cap (with the scoped final round and the fix budget) and the growth brake already bound a lane that does not converge.

Issue 3590: the two emitters refused a focus file with `items`, so a coordinator wrote an agent-made, round-only copy of an operator file for steps 7 and 11.

## Decision

- Delete the `non_convergence` brake: `decideCapRound` loses `actCounts`, `refuseNonConvergence` and the `operatorClear` artifact field go, `resolveCapBrakes` stops returning `actCounts`, and the ADR 0332 decision 5 `bodyOnlyExempt` skip goes. The round cap and the growth brake are unchanged.
- `--operator-focus-file` stays on `write-gate-context.mjs` and `loop gate-coordination` for the remaining stops (ADR 0329).
- Issue 3590: `normalizeOperatorFocus` has no `allowItems` option. `emit-fanout-dispatch.mjs` and `emit-judge-work-order.mjs` validate `items` and keep only `round` in the work order. The gate runbook names one focus file for steps 3, 7 and 11.

## Consequences

A lane no longer stops on a false non-convergence signal, and one operator stop class is gone. A lane that does not converge reaches the round cap or the growth brake. The runbook passes one operator file with no agent-made copy. No new state, flag or rule.
