# 0324. Draft cap 2 and the scoped draft exit

## Status

Accepted — 2026-11-25 ([issue 3464](https://github.com/mfittko/dev-loops/issues/3464), slice 2 of the cap brakes). Amends ADR 0322, ADR 0320 and ADR 0208.

## Context

The v1.0.12 retro on issue 3512 found 1 high in 34 `draft_gate` rounds at round 3 or 4. The `draft_gate` cap of 4 ran rounds that bought almost nothing. The draft cap exit of ADR 0320 still accepted a delta-record chain as the proof to go ready, which the 2026-11-22 decision withdrew. A fix loop on PR 3447 also grew from +96 to +2641 lines against a 120 line forecast, and nothing enforced the growth stop.

## Decision

1. `gates.draft.maxReviewRounds` defaults to 2, the same as `pre_approval_gate`. `0` disables the cap. `GATE-EXEC-LOW-FIX-UNTIL-CAP` is unchanged.
2. `draft_gate` uses the scoped final round of ADR 0322. After cap round 2, a fix within the fix budget is followed by one scoped final round at the exact head, and its clean verdict is the draft exit to `mark_ready_for_review`. A later round, or a fix over the budget, goes to the operator, with the same once-per-set operator clear as `pre_approval_gate`: an operator focus decision on every open act item of the latest closed round clears `round_cap_reached` and `cap_fix_over_budget`, and the over-budget refusal names those fingerprints. A round forced by a base merge counts on neither gate.
3. The draft cap exit of ADR 0320 is deleted: `capExitHolds`, `resolveCapExitRound`, the draft `capFixedReady` route, `capRoundShape`, the `cap:<fingerprint>` seeding of cap-round act items, and the cap-round proof of `pr waive-adr-tripwire`. `GATE-EXEC-ROUND-CAP-EXIT` and `GATE-EXEC-ROUND-CAP-WAIVER-PROOF` are deleted. A draft PR goes ready only on clean current-head `draft_gate` evidence. The ready-PR fold, the merge-time `githubCapFixed` path and the chain walkers stay until issue 3524.
4. The growth brake of ADR 0322 reads `forecastWloc` from the linked issue (`forecastWlocs` in `spec-lint.mjs`, `loadRefinementArtifact`) and `wholeLogicLoc` of the head, at a judged round with an open act item. No linked issue or forecast line gives a `capBrakesWarning` and no stop. With a forecast and a failed growth read (the `origin/<base>` fetch or the size read) the lane stops with `growth_unread` (`report_blocked`, `operator_decision`); a rerun after a successful read or an operator focus decision clears it.
5. `composeBlockedBy` also derives `size_budget` and `ci`. The `blocked_without_findings` refusal of the fixer emitter runs on both gates.

## Consequences

A draft PR runs at most 2 full rounds and one scoped round before the operator decides. No new persisted state, local record or `.devloops` setting is added. A PR that went ready before this change keeps the ready-PR fold until issue 3524.
