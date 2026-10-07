# 0129. On Claude Code the gate coordinator joins its units with `gate wait-for-units`

## Status

Accepted — 2026-10-07 ([PR 2693](https://github.com/mfittko/dev-loops/pull/2693))

## Context

Amends [0112](./0112-gate-coordinator-agent-joins-the-agent-taxonomy.md): the gate coordinator that 0112 defines also owns a harness-specific join of the units it dispatches. The rest of 0112 stands. Amends [0095](./0095-single-wave-gate-fanout.md): the single wave of units is joined by the bounded command below on Claude Code. Records 0095 and 0112 stay unedited.

On Claude Code, a gate coordinator that dispatched a round's units had no sanctioned join. Coordinators waited on completion notifications or wrote unbounded polling loops by hand. A notification can arrive before a unit has written its artifact, or never arrive, so a round either advanced on incomplete units or hung. See [issue 2579](https://github.com/mfittko/dev-loops/issues/2579).

## Decision

On Claude Code the join is the read-only, bounded `dev-loops gate wait-for-units`. The coordinator runs it after dispatch and advances only when it reports every unit complete.

- A completion notification is a trigger to run the check. It is never proof that a unit completed.
- `GATE-EXEC-HARNESS-JOIN` forbids unbounded hand-written waits in the gate coordinator.
- Pi keeps its blocking join.

Rejected alternative: keep joining on completion notifications and hand-written waits (the status quo, which advances on incomplete units or hangs without a bound).

## Consequences

A gate round advances only on observed unit completion, and a stuck unit surfaces as a bounded timeout instead of a hang. Pi behavior is unchanged.
