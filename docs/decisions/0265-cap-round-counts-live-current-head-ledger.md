# 0265. The cap round counts a finished live current-head ledger

## Status

Proposed

Amends [ADR 0250](./0250-clean-cap-round-chain-extension.md) decision item 2. Every other decision of that record stays in force, and the record stays unedited.

## Context

ADR 0250 item 2 treats a clean cap-round head equal to the PR head as the head being posted, so no cap round exists at that head. The coordination detector already counts a finished live current-head ledger (`includeLiveCurrentHead`), so `resolveCapRound` and the detector disagree about the same head. See [issue 3178](https://github.com/mfittko/dev-loops/issues/3178) and [PR 3188](https://github.com/mfittko/dev-loops/pull/3188).

## Decision

1. `resolveCapRound` counts a finished live current-head ledger the same way the coordination detector does (`includeLiveCurrentHead`). A clean cap round at a head equal to the PR head resolves as the cap round at that head. This replaces the clause of ADR 0250 item 2 that said no cap round exists there.
2. The clean `draft_gate` verdict path still applies and nothing is written.
3. `extend-cap-round-chain` still needs a cap-round head that is a strict ancestor of the PR head and refuses `no_cap_round_chain` otherwise. The exit for an unchanged head is a head-moving commit, such as a base refresh.

## Consequences

The resolver and the detector agree on the cap round at the current head. An operator whose clean cap round sits at the PR head needs one head-moving commit before the chain extension runs. No new write path is added.
