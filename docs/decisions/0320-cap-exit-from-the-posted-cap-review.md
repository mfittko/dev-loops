# 0320. The cap exit reads the posted cap review, not the delta chain

## Status

Accepted — 2026-11-23 ([issue 3460](https://github.com/mfittko/dev-loops/issues/3460), with [issue 3523](https://github.com/mfittko/dev-loops/issues/3523) folded in). Amends ADR 0208, ADR 0218, ADR 0250 and ADR 0317 for the cap exit. The chain proof (`resolveCapRoundFixed`) stays the fallback until [issue 3524](https://github.com/mfittko/dev-loops/issues/3524) lands.

## Context

A draft PR at the round cap went ready only when a chain of sealed delta records, linked by commit SHAs, proved the cap round fixed. A base merge, an amend, a thread-route fix or a CI fix broke the chain, and each break received its own exception. PR 3447 ended with five interacting conditions and recovery advice that was wrong for several combinations. In issue 3523 the operator decided to fix an escalated item in the same PR, the emitter refused the item as operator focus, and the chain could not reach the head.

The chain proof protects little. A `bounded_out` delta counts as clearing, CI gate evidence already accepts a capped PR whose cap-round threads are resolved, and `ready-for-review` checks CI, unresolved gate threads, size and the ADR tripwire by itself.

## Decision

- One pure predicate, `capExitHolds` in `write-gate-context.mjs`, decides the cap exit. It holds when `resolveCapRound` resolves the cap round, the round is not blocked, and a trusted posted `draft_gate` review exists at the cap-round head whose header round equals the cap round. This holds for a clean and for a findings round and reads no delta record and no commit ancestry. `draftGatePostedHeads` now carries the posted verdict.
- A blocked round (a posted `blocked` cap verdict at the cap-round head, or a `pastCapBlockers` blocker in the cap ledger) never takes the exit. It keeps the chain proof and the `report_blocked` route: with `blockedOn` `operator_decision` at the cap-round head with act blockers, and with the `no_clearing_record` `agentRemedy` (no `blockedOn`) at a later head.
- `ready-for-review.mjs`, `waive-adr-tripwire.mjs`, the local branch of `detect-checkpoint-evidence.mjs` and `emit-fixer-work-order.mjs` call the exit through `resolveCapExitRound` with the posted heads they already hold (the emitter derives them from its one per-run PR reviews read, which its verdict-marker read shares). `resolveDraftCapRoundFact` calls `capExitHolds` directly with lazily memoized posted heads, so the trust read runs only once a cap round exists. All callers fall back to the chain proof when it does not hold. No caller adds a reviews read.
- Coordination loads the open act list at the cap-round head before ready. An act list routes to the fixer, with ready also allowed once the gate threads are resolved. After a fix pass that ends with no commit, `nextAction` stays `address_review_feedback` and the coordinator takes the allowed `mark_ready_for_review` once the gate threads are resolved.
- Fan-in of `pre_approval_gate` seeds each open act item of the cap round as a finding with the defect key `cap:<fingerprint>`, whatever a delta record says, so the judge disposes it. The verdict poster applies `pastCapBlockers` to the seeded items unless the judge rejects it.
- At the cap-round head, an operator focus item that names an `act` finding of the cap ledger by fingerprint, with a `decision`, binds even when `GATE-EXEC-RECURRENCE-ESCALATION` withheld it from the act list, and the emitter adds the finding to the fixer act list. The escalation rule names the fix in this PR as a third operator outcome.
- At the cap, a `locally_clear` delta result that carries a new low finding ends in ready after the push, and `pre_approval_gate` reviews the final head.

## Consequences

A capped PR whose head moves after the cap round no longer needs the delta chain, a manual operator command or a replacement PR. The accepted risk is that a false "fixed" reply or an unreviewed commit after the cap round is caught at `pre_approval_gate`, one step before merge, where it can cost one more final-gate round. The change writes and migrates no state, so reverting it restores the chain proof as the only exit. The blocked-round accept decision, the posted round count in CI and the removal of the chain code move to issue 3524 and issue 3461.
