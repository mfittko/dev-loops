# 0183. Derive fan-out provenance in the findings-log writer, not in the gate coordinator

## Status

Accepted — 2026-10-25 ([issue 2526](https://github.com/mfittko/dev-loops/issues/2526), slice 2).

## Context

The gate coordinator composed the findings-log provenance block by hand and passed it to
the writer. That block reaches `ledgerVerifiesChecklist`, so a hand-built provenance could
authorize GitHub mutations that no keyed fan-in ledger backed. Judge-pass enriched findings
files also dropped `verifiedItems`, so a clean round lost the evidence it was recorded on.

## Decision

The findings-log writer derives the `fanout_fanin` execution mode itself. It reads the keyed
emit plan or the per-angle findings directory at the current head. When the keyed fan-in
ledger exists, the writer takes `provenance`, `verifiedItems` and `overallVerdict` from that
ledger, and `--verdict` becomes optional.

The writer refuses three inputs:

- an explicit `--provenance` that differs from the derived provenance;
- an explicit `inline_single_agent` mode beside fan-out artifacts at the head;
- a fan-out write without the keyed fan-in ledger, when the keyed emit plan exists at the head.

Rejected alternative: keep coordinator-composed provenance and validate its shape. Shape
validation cannot prove that the keyed artifacts produced the block.

## Consequences

When the keyed emit plan exists at the head, provenance that authorizes mutations comes only from keyed round artifacts and a missing ledger fails closed. The legacy explicit-provenance path with no keyed emit plan is unchanged until slice 3. Coordinators
pass less input. Callers that still pass `--provenance` or
`inline_single_agent` on a fan-out head must drop those flags.
