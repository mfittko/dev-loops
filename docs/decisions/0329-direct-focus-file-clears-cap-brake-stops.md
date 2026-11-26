# 0329. A direct operator focus file clears a cap brake stop, and a repeated set names the operator-only step

## Status

Accepted — 2026-11-26 ([issue 3589](https://github.com/mfittko/dev-loops/issues/3589), [issue 3597](https://github.com/mfittko/dev-loops/issues/3597)); operator mfittko, ask tool.

Amends [0322](./0322-cap-brakes-and-the-scoped-final-round.md) for the clear of an operator stop. ADR 0322 stays unedited.

## Context

ADR 0322 says an operator clear counts only when the issued fixer plan binds to the latest closed round head. That left `loop gate-coordination` stopped with `report_blocked` after the operator wrote a full focus file, because only a fixer plan could clear it. The cap stop reason also named `--operator-focus-file` for every stop, including a set that already had its one re-open, which no focus file clears.

## Decision

- `loop gate-coordination --operator-focus-file <path>` and `write-gate-context.mjs --operator-focus-file <path>` accept the direct file as a clear. The file holds a `decision` for every act fingerprint of the latest judged round, and the issued fixer plan stays an equal source. For a `pre_approval_gate` round forced by a base merge, the direct file also covers the act items of the effective latest round.
- The once-per-set rule of ADR 0322 is unchanged: a set that an earlier round from the round after the effective cap round on already held is not cleared again, by the file or by the plan.
- `resolveCapBrakes` reports `capBrakes.notClearable: true` for that repeated set. The stop reason keeps the `Items:` list and states that the set already had its one re-open, so a focus file does not clear it and the decision stays with the operator. Every other operator stop still names `--operator-focus-file` as the clear input (`GATE-EXEC-NO-DEAD-END`).

## Consequences

An operator clears a first-time stop with one file and gets an accurate reason for a repeated set. The cost is one boolean fact on `capBrakes`. No persisted state is added.
