# 0224. Delta input authenticates the cap-round findings log across the fixer chain

## Status

Accepted — 2026-11-02 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462), follow-up slice B deferred from PR 2998).

Amends [0218](0218-slice-a-cap-round-chain-and-single-child-join.md) and [0197](0197-cap-round-fixed-and-closure-round.md) for the pre-push delta input seam. Accepted records remain unchanged.

## Context

`check-pre-push-delta.mjs` input mode accepts a findings log whose `headSha` differs from the baseline only when the baseline is a base-only merge of that head. After a cap round A, a fixer commit B (a sealed clearing delta record A to B) and a base-only merge M of B, the next fixer commit has baseline M. The log head A is neither M nor a base-only merge predecessor of M, so the input is refused ("records head A, not the baseline M") although the chain A to B to M is already proven by sealed records and the base-only merge check.

## Decision

1. The delta input accepts the cap-round log at an earlier head when any of these holds: the baseline is a base-only merge of the log head (unchanged); the baseline equals the end of a sealed clearing chain that starts at the log head; the baseline is a base-only merge of a chain end.
2. Chain ends come from `clearingChainLastCandidates`, the walk shared with the fixer emitter and `resolveCapRoundFixed`. The input does not add a second walker. The walk needs the log's `repo` and `pr`. A log without them has no chain ends.
3. An unsealed or hand-edited record, a chain that does not reach the baseline, a merge that is not base-only and any error or `.devloops` load failure refuse the log (fail closed).
4. The refusal names two agent-runnable remedies: pass the log recorded at the baseline, or pass the cap-round log whose sealed clearing chain reaches the baseline.

## Consequences

A fixer pass after a cap round, a fixer commit and a base-only merge gets its delta input without a manual re-review. The trust root is unchanged: sealed delta records plus the base-only merge check.
