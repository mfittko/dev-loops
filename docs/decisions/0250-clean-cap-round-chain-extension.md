# 0250. A clean cap round with no fixer pass is a cap-round chain of length zero

## Status

Accepted, 2026-11-04 ([issue 3079](https://github.com/mfittko/dev-loops/issues/3079)).

Amends [ADR 0224](./0224-cap-round-proof-for-adr-waiver-and-docs-tests-chain-extension.md) and [ADR 0208](./0208-draft-cap-round-fixed-goes-ready.md). Every other decision of those records stays in force, and the records stay unedited.

## Context

ADR 0208 defines the cap round as the last closed `draft_gate` ledger at the cap when it is `findings_present` or holds an open act item. ADR 0224 extends the sealed chain over docs and tests commits, starting from a record that a fixer pass wrote.

A PR whose cap round came back clean has no fixer pass and no record. A docs-only commit after it (an ADR that clears the ADR tripwire, PR 3078) moves the head past the clean round. `resolveCapRound` returns null, `extend-cap-round-chain` refuses `no_cap_round_chain`, and `draft_gate` refuses a further round. No sanctioned command remains.

## Decision

1. `resolveCapRound` also returns the cap round when the last closed ledger at the cap is `clean`. Its `residue` is empty and `pre_approval_gate` receives no residue. With no act item to cover, `capRoundCovers` accepts only a first record whose sealed clearing chain carries `extension: "docs_tests_only"`, so a plain clearing record bound to a clean cap-round head (a thread-route record over a logic commit) does not prove the round alone. When such a plain record exists, `extend-cap-round-chain` takes the end E of its chain, seals the extension record at E and never overwrites the plain record, so the round has a sanctioned exit.
2. `extend-cap-round-chain` treats a clean cap round with no chain end as a chain of length zero. The chain end is the cap-round head, which must be a strict ancestor of the PR head. A clean cap-round head equal to the PR head is the head being posted, so no cap round exists, the clean `draft_gate` verdict path applies and nothing is written. A cap-round head outside the head's history still refuses `baseline_orphaned`.
3. All later checks of ADR 0224 stay: only docs and tests files count (`logic_commit_in_range` otherwise), a non-base-only merge refuses, the record is created exclusively, and a failed `resolveCapRoundFixed` proof removes it. The sealed record is bound to the cap-round head with `candidateHead` the PR head, `outcome` `locally_clear`, no items and `extension: "docs_tests_only"`.

The proof stays a sealed record read through `readSealedGateDeltaRecord`. `resolveCapRoundFixed` gains no git diff and no classifier. The cap value, code-commit recovery ([issue 3049](https://github.com/mfittko/dev-loops/issues/3049)) and `contract_doc_not_in_matrix` are unchanged.

## Consequences

A PR with a clean cap round and a docs-only or tests-only follow-up reaches `ready-for-review` through `gate extend-cap-round-chain`. A logic commit still fails closed. Consumers of `resolveCapRound` (the `pre_approval_gate` ordering check, `merge-pr` gate evidence) see an empty residue for a clean cap round.
