# 0317. Cap-round coverage is the union of the clearing chain's records

## Status

Accepted — 2026-11-22 ([issue 3443](https://github.com/mfittko/dev-loops/issues/3443)). Amends ADR 0208 and ADR 0224.

## Context

A cap round with three act items had one item escalated under `GATE-EXEC-RECURRENCE-ESCALATION`. The operator chose to fix it in the PR. The commit_only fixer record covered the two other act refs. A thread-route fixer and a delta review then fixed the escalated item against a later baseline and sealed a second `locally_clear` record. `capRoundCovers` read only the first record of the chain, so the proof refused `items_do_not_cover` and the only exit was a replacement PR.

## Decision

- `capRoundCovers` accepts a non-clean cap round when the union of the `items` refs of every sealed clearing record on the chain that starts at the first record names every act ref. One helper (`capRoundCoverage`) computes the union and returns the uncovered refs and the records read.
- Each link's baseline is the previous link's candidate head, so every baseline is an ancestor of the head the chain reaches. The proof still requires the chain to reach the head.
- The `extend-cap-round-chain` `no_cap_round_chain` refusal for a non-covering sealed record names the uncovered act refs and the records that exist. Its `recovery` stays the replacement-PR operator form, because the refusal now fires only when a ref is genuinely uncovered.
- Existing delta records are never overwritten. The round cap and the escalation rule are unchanged.

## Consequences

A thread-route fix of an escalated cap-round item no longer needs a replacement PR. A cap round with a genuinely uncovered act ref still refuses and names it.
