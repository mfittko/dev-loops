# 0333. A spec-decision stop retires automatically after the spec changes

## Status

Accepted — 2026-11-26 ([issue 3612](https://github.com/mfittko/dev-loops/issues/3612)).

Amends [0314](./0314-gate-rebuild-retires-the-stale-round.md): a fan-in ledger without a findings log is no posted verdict when the round stopped at the human-spec-decision state and the spec digest changed. The rest of that record stays unedited.

## Context

`consolidate-fanin` writes the keyed fan-in ledger at runbook step 10, before the judge. A round that stops at step 13 with `humanDecisionRequired` leaves that ledger, sentinels and dispatch records and no findings log, so it posts no verdict: the verdict comment renders only from the findings log. After the human edits the spec, the same-head rerun hit `GATE-EXEC-ROUND-RETIREMENT` (ledger treated as a posted verdict) or the fresh-context sentinel refusal. Each case cost an operator ask, a lane resume and a coordinator dispatch.

## Decision

1. `retireStaleRound` retires the round through the existing `retireGateRound` when all three hold at the full head: no findings log in any verdict root; the judge plan's `spec-authority-verdict.json` holds a `spec_cannot_decide` decision; and the plan-pinned `workOrder.authority.specDigest` differs from the digest the builder computes from the spec it loaded (the pinned digest differs from both the issue body digest and the PR body digest). The judge plan is newer than every sentinel and dispatch record.
2. The builder computes the digest through `specDigestFromBody`, the spec-source branch it shares with `spec-context.mjs`. No single spec source means no digest and the refusal stands.
3. The builder runs the check on every rebuild at the head, also with unchanged prefix bytes. The retirement reason names `SPEC-AUTHORITY-HUMAN-DECISION-LAST-RESORT` and the pinned digest plus each current spec digest (12 characters each, up to three).
4. A findings log, a missing or unreadable judge file or an unchanged digest keeps the refusal and its operator recovery. The live-sentinel refusal is unchanged.

## Consequences

A spec decision no longer needs an operator-approved retirement. No new state, flag or script exists. Revert by removing the `stopped` branch in `retireStaleRound` and the same-bytes call in the builder.
