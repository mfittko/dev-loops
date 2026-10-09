# 0135. Config-source carry-forward override runs on the unreduced delta

## Status

Accepted — 2026-10-09 ([PR 2706](https://github.com/mfittko/dev-loops/pull/2706))

## Context

Amends [0030](./0030-angle-carry-forward-fail-closed.md): the carry-forward seam stays fail-closed as 0030 defines it. This record only changes which file list the config-source override reads. Record 0030 stays unedited.

The override ran on the base-reduced delta. A head that reverted `.devloops` to `main` reduced to an empty config delta, so carried angles were not forced to re-run. See [issue 2685](https://github.com/mfittko/dev-loops/issues/2685).

## Decision

For rule `GATE-EXEC-ANGLE-CARRY-FORWARD`:

- The config-source override runs on the unreduced `prev-head..head` name-status list (`incrementalFiles`, rename and copy source paths included) before base reduction. A config-source change forces every angle to re-run, even when the head reverts `.devloops` to `main`. The override is exempt from the base-move carry.
- The Copilot convergence carry uses the reduced delta and does not consult config sources.
- Non-config deltas keep the base-relative reduction.

## Consequences

A config-source change in the head-bump range always re-runs every angle. The Copilot convergence carry is unchanged.
