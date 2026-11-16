# 0286. A later cap-round fixer pass runs at a head the sealed clearing chain reaches

## Status

Accepted, 2026-11-16 ([issue 3105](https://github.com/mfittko/dev-loops/issues/3105)).

Amends [ADR 0208](./0208-draft-cap-round-fixed-goes-ready.md) and [ADR 0254](./0254-cap-chain-delta-extension.md). Every other decision of those records stays in force, and the records stay unedited.

## Context

ADR 0208 gives the cap round one fixer pass. After that pass lands, the PR head has no ledger and counts as round cap+1, so `emit-fixer-work-order.mjs` refuses a further fixer order with `round_cap_reached`. A fixer pass that fixes only part of the cap round's act list strands the rest. PR 3237 stranded 4 of 7 act items this way. ADR 0254 already extends the sealed clearing chain over each later commit that a `locally_clear` pre-push delta covers.

## Decision

1. `emit-fixer-work-order.mjs` accepts a second or later cap-round fixer pass when the caller passes the PR head, the ledgerless PR head descends from the cap-round head, and the cap round's sealed clearing chain reaches the PR head (`clearingChainWalk`, ADR 0254 and ADR 0261). The emitter reads the cap-round ledger and the posted verdict at the cap-round head and emits the order at the PR head.
2. A later pass emits only act items of the cap-round ledger. Any other act item refuses with `round_cap_reached`. This bounds the number of passes by the cap round's act list.
3. Any other commit in the range keeps the `round_cap_reached` refusal. The refusal names `dev-loops gate extend-cap-round-chain` (`GATE-EXEC-ROUND-CAP-CHAIN-EXTEND`) as the remedy.
4. `GATE-EXEC-ROUND-CAP` in `skills/docs/gate-review-sub-loop-contract.md` records this exception.

## Consequences

- A partial cap-round fix no longer strands the remaining act items. The fixer runs again at the PR head.
- No new review round runs past the cap. A later pass cannot add findings, so the passes end when the cap round's act list is fixed.
- A head that the chain does not reach still refuses. The operator extends the chain first and re-emits at the PR head.

## Residual risk

Any sealed clearing record counts as proof that the chain reaches a head. This includes docs and tests chain extensions and reviewer-only records, as well as fixer-route records. A later pass can therefore run at a head whose last commit was not a fixer commit. This is the same proof that already lets a cap-fixed PR leave draft under ADR 0208, so the change adds no new trust in the clearing records.
