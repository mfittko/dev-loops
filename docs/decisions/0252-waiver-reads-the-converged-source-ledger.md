# 0252. The ADR waiver reads the sealed ledger of the round a clean marker names

## Status

Accepted, 2026-11-05 ([issue 3101](https://github.com/mfittko/dev-loops/issues/3101)).

Amends [ADR 0188](./0188-low-nit-never-block.md) (as amended by [ADR 0196](./0196-pre-approval-gate-low-nit-never-block.md)) and [ADR 0250](./0250-clean-cap-round-chain-extension.md). Every other decision of those records stays in force, and the records stay unedited.

## Context

A `draft_gate` round that converges on low and nit findings (`GATE-EXEC-LOW-NIT-CONVERGENCE`) updates the comment at the reviewed head A to `clean`. The fixer commit B then becomes the PR head. The comment parses at B as a clean marker with `convergedFromHeadSha` A. A verdict carried across a base-only merge has the same shape: the marker names the current head and holds the origin in `carriedFrom`.

The only sealed ledger lies at A. `waive-adr-tripwire.mjs` read the recorded `specDigest` from the ledger of the current head B and refused `spec_digest_unrecorded`. The only exit was an extra full round, which costs a round of the cap. The reader also parsed the ledger without its seal.

## Decision

1. When the clean current-head `draft_gate` marker is the digest source, the waiver reads the ledger at `convergedFromHeadSha`, else `carriedFrom`, else the current head. Heads compare case-insensitively. A marker head that is a prefix of the current head resolves to the current head. The `pre_approval_gate` source keeps the current head.
2. `defaultReadRecordedSpecDigest` reads the ledger through `readSealed`. A read, seal or parse error returns null, so a hand-edited ledger refuses `spec_digest_unrecorded`.
3. The digest comparison is unchanged. A spec edit after the judged round refuses `spec_digest_mismatch`.

A marker head that is neither a full head nor a prefix of the current head names no ledger, so the waiver refuses `spec_digest_unrecorded`. `readSealed` accepts a ledger that has no seal file, as `resolveCapRound` does, so the seal check covers an edit of the ledger and not the deletion of its seal.

The head comes from the marker the gate wrapper posted. The waiver never walks git ancestors, and no writer, ledger shape or marker shape changes.

## Rejected alternatives

- A typed converged ledger at B. It is a second writer of `specAuthority` and a new sealed artifact. `countCompletedRounds` would count it as a closed round and `findEscalations` as a prior log.
- The nearest ancestor ledger. It is an unbounded git walk with no binding to the judged round.
- A synthetic clean ledger from `gate write-findings-log --spec-authority`. It is fabricated evidence.
- A full extra round. It spends a cap round and adds no review value.

## Consequences

A PR that converges on low and nit findings and needs an ADR waiver gets the waiver without an extra round. The digest still comes from a ledger that a round actually produced and the sanctioned writer sealed. `detect-checkpoint-evidence.mjs` already resolves a converged marker to the ledger of A, and the waiver now follows it.
