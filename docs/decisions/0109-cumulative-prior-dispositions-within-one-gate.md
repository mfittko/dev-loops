# 0109. Cumulative prior dispositions within one gate

## Status

Accepted — 2026-09-28 ([issue #2528](https://github.com/mfittko/dev-loops/issues/2528))

Amends [ADR 0070](./0070-disposition-memory-into-rerunning-reviewer-briefing.md): the `write-gate-context.mjs --prev-head <A>` seam that read one named prior head is replaced by discovery of every earlier head's ledger of the same gate. This record also replaces ADR 0070 choice 4: with no flag there is no same-head parse guard, and discovery skips the current head's ledger instead. The rest of ADR 0070 stays in force: reject and defer dispositions only, attribution scoped to angles that re-run this round, the identity and verdict-eligibility checks, and a write that never blocks on prior-round memory.

## Context

ADR 0070 seeded a re-running reviewer with the dispositions of the one prior head that the caller named, and only when the caller passed `--prev-head`. A finding disposed in round 4 was therefore unknown to round 9 when rounds 5 to 8 sat between them. On PR #2440 the same contract-surface lows were re-raised in rounds 1, 4, 5 and 9.

## Decision

`write-gate-context.mjs` has no `--prev-head` option and no alias; the parser rejects it as an unknown option. `resolve-angle-carry-forward.mjs` keeps its own `--prev-head`. On every run the context builder reads every `<gate>-<sha>.json` findings-log ledger of the same gate on the PR at a head other than the current head, from the main-anchored ledger directory. It orders the ledgers oldest round first and folds findings by `fingerprintFinding` identity. The latest disposition of a finding wins, so a later `act` removes an earlier reject.

The read fails open per ledger: an unreadable or malformed ledger contributes nothing. The identity and verdict-eligibility checks fail closed per ledger: an absent or foreign repo, PR, gate or head, or a verdict other than `clean` or `findings_present`, drops that ledger, and the write proceeds with the remaining ledgers. A ledger at the current head, in either SHA-prefix direction, is skipped at discovery. The cumulative list stays lossless per [ADR 0086](./0086-gate-fanout-reference-seeded-work-orders.md), with no entry cap, per-field truncation or overflow line.

We rejected carrying dispositions across gates, because an earlier gate judged a different scope. We rejected carrying `act` dispositions, because they are live findings.

## Consequences

No caller can forget or misname the prior head, and a disposition from any closed round of the gate reaches every later round. The `prior-dispositions` read can grow with the number of rounds; it stays a hash-bound required read outside the prompt. `test/github/write-gate-context.test.mjs` pins the discovery, fold, per-ledger checks and the rejected flag.
