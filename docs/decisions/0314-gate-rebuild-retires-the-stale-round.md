# 0314. A context rebuild or re-emission at the same head retires the stale round

## Status

Accepted — 2026-11-21 ([issue 3416](https://github.com/mfittko/dev-loops/issues/3416))

Amends `GATE-EXEC-ROUND-RETIREMENT` in the gate review sub-loop contract: the rule body no longer says the builder never retires implicitly. Retirement is automatic for a live round without a verdict and refuses with a `recovery` field when a verdict exists. The explicit `retire-gate-round.mjs` command stays for a round with a verdict and for a rewrite of a prior-dispositions or scoped-variant file.

## Context

A coordinator that rebuilt the gate context or re-ran `emit-fanout-dispatch.mjs` at a head with an old round left that round's sentinels, dispatch records and artifacts in place. Fresh reviewers were then refused, and a refused reviewer overwrote real findings with a blocked artifact. Only an explicit retirement cleared the state, and no refusal named it.

## Decision

- `write-gate-context.mjs` (on a byte-changing prefix rebuild at a full head) and a full `emit-fanout-dispatch.mjs` emission retire the undispatched or partial round of that gate and head through the `retire-gate-round.mjs` logic, and report `retiredRound`.
- A round with a posted verdict at that head (a fan-in ledger or a findings log) and a live sentinel, dispatch record or findings directory is never retired automatically. Both scripts refuse and return a `recovery` field. A verdict marker with nothing live (the round was retired manually; retirement leaves the ledger and log in place) does not refuse.
- The prefix-change retirement does not check whether a reviewer is still writing. A reviewer dispatched under the old prefix and still running can write a same-head artifact into the recreated findings directory. This race is accepted: rebuilding while reviewers run is already forbidden by the contract, and an in-flight check needs per-angle dispatch state the builder does not hold on this path.
- A blocked-result writer refuses to overwrite a finished per-angle artifact, except that an over-budget run that reports every angle covered blocks all its angles and overwrites their own artifacts.
- The fresh-context sentinel is unchanged.

## Consequences

A coordinator no longer needs a manual retirement step between a rebuild and a fresh fan-out. A posted verdict keeps the operator-owned explicit path.
