# 0314. A context rebuild or re-emission at the same head retires the stale round

## Status

Accepted — 2026-11-21 ([issue 3416](https://github.com/mfittko/dev-loops/issues/3416))

Amends `GATE-EXEC-ROUND-RETIREMENT` in the gate review sub-loop contract: retirement is automatic for a round without a verdict. The explicit `retire-gate-round.mjs` command stays for a round with a verdict.

## Context

A coordinator that rebuilt the gate context or re-ran `emit-fanout-dispatch.mjs` at a head with an old round left that round's sentinels, dispatch records and artifacts in place. Fresh reviewers were then refused, and a refused reviewer overwrote real findings with a blocked artifact. Only an explicit retirement cleared the state, and no refusal named it.

## Decision

- `write-gate-context.mjs` (on a byte-changing prefix rebuild at a full head) and a full `emit-fanout-dispatch.mjs` emission retire the undispatched or partial round of that gate and head through the `retire-gate-round.mjs` logic, and report `retiredRound`.
- A round with a posted verdict at that head (a fan-in ledger or a findings log) is never retired automatically. Both scripts refuse and return a `recovery` field.
- A blocked-result writer refuses to overwrite a finished per-angle artifact.
- The fresh-context sentinel is unchanged.

## Consequences

A coordinator no longer needs a manual retirement step between a rebuild and a fresh fan-out. A posted verdict keeps the operator-owned explicit path.
