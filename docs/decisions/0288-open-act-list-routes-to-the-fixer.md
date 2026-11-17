# 0288. An open draft_gate act list at the current head routes to the fixer

## Status

Accepted, 2026-11-17 ([issue 3105](https://github.com/mfittko/dev-loops/issues/3105)).

Amends [ADR 0208](./0208-draft-cap-round-fixed-goes-ready.md), [ADR 0224](./0224-cap-round-proof-for-adr-waiver-and-docs-tests-chain-extension.md), [ADR 0250](./0250-clean-cap-round-chain-extension.md) and [ADR 0251](./0251-soft-round-cap.md). Every other decision of those records stays in force, and the records stay unedited.

## Context

`evaluatePrGateCoordination` ignored the act list of a posted `findings_present` verdict. Below the cap it returned `run_draft_gate` again (PR 3221). At the cap round it returned `report_blocked` with `no_clearing_record`, whose remedy assumes fix commits that no fixer pass made (PR 3239). On a stale base the detector turned `run_draft_gate` into `base_stale_integrate_first` (PR 3234). Each case needed a manual resume.

## Decision

1. `detect-pr-gate-coordination-state.mjs` reads the current head's `draft_gate` ledger. When its verdict is `findings_present` and it names an open act item, the detector passes `draftOpenActList` (`headSha`, `openActCount`, `blockers`, `fixerInFlight`) to the evaluator. `blockers` is `pastCapBlockers` for a round at or past the cap, and empty below it. `fixerInFlight` (decision 6) is true when the PR's `fixer-emit-plan.json` targets this PR at this head and its fixer has not handed back; it then also carries `fixerPlanPath` and `fixerJoinRef`. An unusable plan carries `fixerPlanError`. A `draftOpenActList` read error fails safe to no act list, except `OUT_OF_BAND_WRITE`, which the detector rethrows.
2. On a draft PR whose posted `draft_gate` verdict at the current head is `findings_present`, a `draftOpenActList` bound to that head with no blocker returns `address_review_feedback`. Its `agentRemedy` names `emit-fixer-work-order.mjs --phase commit_only --gate draft_gate --head-sha <current head>` with the judge-pass act list.
3. A blocker keeps the cap-round `report_blocked` and names `blockedOn: operator_decision`.
4. A moved head has no ledger, so the earlier routing applies.
5. At the cap, the route replaces only the `no_clearing_record` refusal. Every other cap-round failure (`unsealed_record`, `items_do_not_cover`, `chain_does_not_reach_head`, `cap_round_unresolved`, `baseline_orphaned`) keeps its routing.
6. `fixerInFlight` uses the `close-gate-sequence.mjs` predicate: the PR's plan baseline (`authority.reviewBaselineHead`, else `headSha`) is the current head and its `outputRefs[0]` does not exist, so its fixer has not handed back. With `fixerInFlight` true, the route returns `address_review_feedback` whose `agentRemedy` joins the plan's `joinRef` with `gate wait-for-units --after <planPath>` and resumes that sequence. It never re-emits the fixer order and never falls back to `run_draft_gate` or `base_stale_integrate_first`. A handed-back, crashed or abandoned plan at the head leaves the emission route open, and the same-head no-commit re-emission stays a normal step. Only a missing plan counts as no plan: an unreadable, unparsable or digest-mismatched plan surfaces as `unverified_active_fixer` in the reason, as `readFixerDispositionEvidence` reports it, and the emission replaces the plan.
7. At the cap, the route requires `draftCapRoundFailure` to be `no_clearing_record`. A null failure fails closed to the refusal.

## Consequences

- The fixer runs before a repeated round, a cap-round refusal or a base integration.
- The base freshness step runs only on a gate-run action, so the fixer route skips it. The fix push re-checks the base.
- `GATE-EXEC-SOFT-CAP` in `skills/docs/gate-review-sub-loop-contract.md` states the route.
