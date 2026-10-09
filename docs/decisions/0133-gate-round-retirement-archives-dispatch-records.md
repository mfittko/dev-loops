# 0133. Gate-round retirement archives dispatch-prompt records

## Status

Accepted — 2026-10-09 ([issue 2709](https://github.com/mfittko/dev-loops/issues/2709))

## Context

`GATE-EXEC-ROUND-RETIREMENT` in [gate-review-sub-loop-contract.md](../../skills/docs/gate-review-sub-loop-contract.md) archives a retired round's sentinels and findings. The round's dispatch-prompt records stayed in place. A later fan-in for the same gate and head could read those stale records as evidence of a fresh dispatch.

## Decision

- Gate-round retirement archives the round's dispatch-prompt records together with its sentinels and findings. The archive keeps the original bytes. `retirement.json` lists the archived records as `dispatchPromptRecords`.
- After such a retirement, fan-in for that exact gate and full head requires `--emit-plan` and at least one fresh dispatch record. Fan-in refuses a plan unit whose execution appears in the archive.
- Fan-in refuses a short head when a retirement audit exists for a head it prefixes.

Rejected: an inventory, digest, symlink or alias layer over the archive (machinery with no consumer).

## Consequences

A retired round's dispatch records can no longer satisfy a later fan-in. A rerun after retirement must dispatch fresh units. Callers that pass a short head after a retirement must pass the full head.
