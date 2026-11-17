# 0288. An open draft_gate act list at the current head routes to the fixer

## Status

Accepted, 2026-11-17 ([issue 3105](https://github.com/mfittko/dev-loops/issues/3105)).

Amends [ADR 0208](./0208-draft-cap-round-fixed-goes-ready.md) and [ADR 0251](./0251-soft-round-cap.md). Every other decision of those records stays in force, and the records stay unedited.

## Context

`evaluatePrGateCoordination` ignored the act list of a posted `findings_present` verdict. Below the cap it returned `run_draft_gate` again (PR 3221). At the cap round it returned `report_blocked` with `no_clearing_record`, whose remedy assumes fix commits that no fixer pass made (PR 3239). On a stale base the detector turned `run_draft_gate` into `base_stale_integrate_first` (PR 3234). Each case needed a manual resume.

## Decision

1. `detect-pr-gate-coordination-state.mjs` reads the current head's `draft_gate` ledger. When its verdict is `findings_present` and it names an open act item, the detector passes `draftOpenActList` (`headSha`, `openActCount`, `blockers`) to the evaluator. `blockers` is `pastCapBlockers` for a round at or past the cap, and empty below it.
2. On a draft PR whose posted `draft_gate` verdict at the current head is `findings_present`, a `draftOpenActList` bound to that head with no blocker returns `address_review_feedback`. Its `agentRemedy` names `emit-fixer-work-order.mjs --phase commit_only --gate draft_gate --head-sha <current head>` with the judge-pass act list.
3. A blocker keeps the cap-round `report_blocked` and names `blockedOn: operator_decision`.
4. A moved head has no ledger, so the earlier routing applies.

## Consequences

- The fixer runs before a repeated round, a cap-round refusal or a base integration.
- The base freshness step runs only on a gate-run action, so the fixer route skips it. The fix push re-checks the base.
- `GATE-EXEC-SOFT-CAP` in `skills/docs/gate-review-sub-loop-contract.md` states the route.
