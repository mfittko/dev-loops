# 0171. The fan-in derives fan-out provenance and writes a keyed fan-in ledger

## Status

Accepted — 2026-10-20 ([issue 2526](https://github.com/mfittko/dev-loops/issues/2526), slice 1)

## Context

A `fanout_fanin` ledger write requires `provenance`. The fan-in wrote no provenance, so every gate coordinator built `provenance.perAngle` by hand from the emit plan. That recorded each planned unit as the reviewer of its angles whether or not a fresh artifact existed. Since the verdict upsert trusts this provenance before it edits PR and issue bodies, hand-built provenance could authorize a GitHub mutation. The hand-building also made the ledger writer refuse the write two to eleven times per round.

## Decision

- With `--emit-plan`, `consolidate-fanin.mjs` derives `provenance` from the head-stamped per-angle artifacts, the emit-plan units and the carry-forward plan. A fresh angle takes its unit's `executionIdentity` as `dispatchId` and the unit's `group` (no `group` key for a singleton). An angle without a head-stamped artifact gets no fresh entry. A carried angle records `carriedFromHead`, `carriedVerdict` and the prior identity from the carry-forward plan.
- The fan-in also writes the same ledger to a keyed path, `<gate>-<headSha>.fanin-ledger.json`, beside the emit plan. It removes a stale keyed file once the emit-plan key is verified, before any later refusal or write; a run refused by the plan-key guard leaves a prior keyed file in place.
- The fan-in fails closed when the plan has a fresh unit and the head has zero dispatch-prompt records for the plan's gate.
- The ledger writer stops accepting caller-built provenance in a later slice of the same issue. This record covers the fan-in side only.

## Consequences

Provenance for a `fanout_fanin` round comes from disk evidence the fan-in already verified. A coordinator no longer composes it. The keyed ledger is the input the writer will read in the next slice. The change does not make provenance cryptographically unforgeable.
