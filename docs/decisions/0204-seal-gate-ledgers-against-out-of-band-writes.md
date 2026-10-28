# 0204. The keyed fan-in ledger and the findings log carry a seal that refuses out-of-band writes

## Status

Accepted — 2026-10-28

## Context

Issue [2971](https://github.com/mfittko/dev-loops/issues/2971) reports that no writer refused a hand edit of the keyed fan-in ledger. The edit broke carry-forward integrity at the next head.

## Decision

- The sanctioned writers (`consolidate-fanin.mjs` for the keyed ledger, `write-gate-findings-log.mjs` for the findings log) write a sha256 seal file `<artifact>.seal` beside the artifact.
- The sanctioned readers (the findings-log writer reading the ledger, `resolve-angle-carry-forward.mjs` and `emit-fanout-dispatch.mjs` reading the prior findings log) verify the seal.
- A seal mismatch fails with the typed reason `gate_artifact_out_of_band_write`, which names the file.
- An artifact with no seal reads as a legacy artifact and is accepted. Refusing a missing seal and the routed-residue input remain open under the issue.

## Consequences

A hand edit of a sealed artifact fails at the next read. A writer that also rewrites the seal is out of reach of this check.
