# Copilot Loop State Graph

Canonical owner for the async Copilot review/fix loop state machine.

## Overview

The state machine captures observable PR/GitHub/worktree facts (the **snapshot**) and maps them to exactly one **current state**, a list of **allowed next transitions**, and a **recommended next action**.

This document is the Copilot-family inner-loop state machine. The broader family-local PR lifecycle that consumes this machine is defined in [PR Lifecycle Contract](./pr-lifecycle-contract.md).

The implementation lives in:

- **Pure logic**: `packages/core/src/loop/copilot-loop-state.mjs` — state constants, transition table, `normalizeSnapshot`, `interpretLoopState`
- **CLI**: `scripts/loop/detect-copilot-loop-state.mjs` — auto-detect or `--input` snapshot interpretation

## State Definitions

| State | Meaning |
|---|---|
| `no_pr` | No open PR exists for the current work |
| `pr_draft` | PR exists but is in draft state |
| `pr_ready_no_feedback` | PR is ready-for-review; no Copilot review requested or received yet |
| `waiting_for_copilot_review` | Copilot review is still active for the current head via `requested_reviewers`, an immediately confirmed request, or a pending current-head review; waiting for the current-head review-request lifecycle to settle |
| `unresolved_feedback_present` | Unresolved review threads exist that require fix and/or reply/resolve |
| `already_fixed_needs_reply_resolve` | Agent has applied a fix; threads still need reply/resolve on GitHub before re-request |
| `ready_to_rerequest_review` | All threads resolved; Copilot has reviewed at least once; only re-request once the updated head is green or credibly green |
| `review_request_unavailable` | Copilot review request returned `unavailable` and no observable in-progress review evidence exists; must stop/report |
| <!-- term: state:waiting_for_ci --> `waiting_for_ci` | CI checks are in progress or no usable CI readiness signal exists yet; wait before proceeding |
| `blocked_needs_user_decision` | Unexpected failure (CI failure, bad request result); requires user decision |
| `done` | The loop's work at this boundary is complete: the PR was merged or closed, or a terminal hand-off occurred (e.g. re-request handed back to the watcher, internal-tooling PR proceeding to `pre_approval_gate`) |
| <!-- term: state:internal_tooling_direct_gate --> `internal_tooling_direct_gate` | Internal-tooling-only PR; Copilot external review is skipped and the loop proceeds directly to `pre_approval_gate`. Externally assigned by the routing layer, never derived from a snapshot by `interpretLoopState` — no snapshot field drives it |

Three additional terminal states (`low_signal_converged`, `round_cap_reached`,
`round_cap_clean_fallback`) are owned by the round-cap/low-signal refinement heuristics in
`copilot-loop-state.mjs`'s `NEXT_ACTIONS`/`isCopilotRoundCapReached` and are out of scope for
this document's interpretation rules; see that module for their entry conditions.

## Required transitions

Terminal states with no outgoing transitions: `no_pr`, `review_request_unavailable`,
`blocked_needs_user_decision`, `done`, `low_signal_converged`, `round_cap_reached`,
`round_cap_clean_fallback`.

- `pr_draft` -> `pr_ready_no_feedback`
  - move PR from draft to ready
- `pr_ready_no_feedback` -> `waiting_for_copilot_review`
  - request Copilot review
- `waiting_for_copilot_review` -> `unresolved_feedback_present`
  - Copilot reviewed; unresolved threads exist
- `waiting_for_copilot_review` -> `ready_to_rerequest_review`
  - Copilot reviewed; all threads resolved
- `waiting_for_copilot_review` -> `waiting_for_ci`
  - CI checks are running or have not materialized yet
- `unresolved_feedback_present` -> `already_fixed_needs_reply_resolve`
  - agent applied fix; threads still open on GitHub
- `unresolved_feedback_present` -> `unresolved_feedback_present`
  - iterative: address one thread at a time
- `already_fixed_needs_reply_resolve` -> `ready_to_rerequest_review`
  - all threads replied to and resolved
- `ready_to_rerequest_review` -> `waiting_for_copilot_review`
  - re-request another Copilot pass
- `ready_to_rerequest_review` -> `review_request_unavailable`
  - re-request failed with unavailable
- `ready_to_rerequest_review` -> `done`
  - agent decides PR is complete
- `waiting_for_ci` -> `pr_ready_no_feedback`
  - CI passed; no review yet
- `waiting_for_ci` -> `ready_to_rerequest_review`
  - CI passed; Copilot has reviewed before
- `waiting_for_ci` -> `blocked_needs_user_decision`
  - CI failed
- `internal_tooling_direct_gate` -> `done`
  - internal-tooling PR skips Copilot review and proceeds directly to `pre_approval_gate`

## Snapshot Schema

The snapshot is the set of observable facts that the interpreter uses to determine the current state.

| Field | Type | Description |
|---|---|---|
| `prExists` | `boolean` | Whether a PR was found |
| `prNumber` | `number \| null` | PR number if `prExists`, otherwise `null` |
| `prDraft` | `boolean` | Whether the PR is in draft state |
| `prMerged` | `boolean` | Whether the PR has been merged |
| `prClosed` | `boolean` | Whether the PR was closed without merge |
| `copilotReviewRequestStatus` | `"requested" \| "already-requested" \| "unavailable" \| "none" \| "failed"` | Current known Copilot review-request state |
| `copilotReviewPresent` | `boolean` | Whether at least one Copilot review exists on the PR |
| `copilotReviewOnCurrentHead` | `boolean` | Whether a submitted (non-PENDING) Copilot review exists for the current head commit; this proves review activity exists for the head, but an active `requested` / `already-requested` request still keeps the wait open until the request state settles |
| `unresolvedThreadCount` | `number` | Total unresolved review-thread count |
| `actionableThreadCount` | `number` | Unresolved threads with non-bot actionable comments |
| `copilotBodyFeedbackUnresolved` | `boolean` | Whether the latest current-head Copilot review carries an unresolved BODY-level finding (a `CHANGES_REQUESTED` review, or a `COMMENTED` review whose body signals "Changes recommended"), independent of inline threads. Unioned with `unresolvedThreadCount` so a body-only finding with zero inline threads still routes to unresolved feedback. A trusted disposition record for the current head clears it (`COPILOT-STATE-BODY-DISPOSITION-RECORD`) |
| `copilotPriorHeadBodyFeedbackUnresolved` | `boolean` | Whether the latest Copilot review sits on an earlier head and is a body-only changes-recommended or unrecognized review (no thread of its own) that no trusted disposition record names (`COPILOT-STATE-BODY-DISPOSITION-RECORD`). At the round cap it blocks `round_cap_clean_fallback`. Below the cap, with a submitted current-head review, it routes to `blocked_needs_user_decision` (rule 9) |
| `ciStatus` | `"success" \| "failure" \| "pending" \| "none"` | Current CI check rollup; `none` means no usable CI readiness signal yet and is not treated as green |
| `agentFixStatus` | `"applied" \| null` | Agent-provided: `"applied"` when code has been fixed |

### Review request status values

| Value | Meaning |
|---|---|
| `requested` | Copilot is currently in `requested_reviewers`, whether detected directly or immediately after a successful request; also set when a PENDING Copilot review for the current head commit is detected as observable in-progress evidence |
| `already-requested` | A caller with prior request-attempt context knows Copilot review was already observably in progress before or after that attempt (for example: `requested_reviewers`, a PENDING review for the current head commit, or post-failure verification after a rejected request) |
| `unavailable` | GitHub rejected the request (Copilot review not enabled, not a collaborator, etc.) **and** no observable in-progress review evidence was found |
| `none` | Copilot is not currently requested and there is no stronger request-attempt result to inject |
| `failed` | A prior request attempt failed unexpectedly |

### Agent judgment boundary

The `agentFixStatus` field is the only explicit agent input to the state machine.

The machine detects all other fields from observable GitHub/git facts. Agent decisions that are **not** encoded in the snapshot (and remain in the agent layer):

- Whether a comment should be accepted, deferred, or disagreed with
- Whether the code is already fixed (→ sets `agentFixStatus: "applied"`)
- What the narrowest valid fix is
- Whether another Copilot pass is actually desired (→ triggers re-request or selects `done`)

## Interpretation Rules (ordered)

The interpreter applies rules in priority order. The first matching rule wins.

1. `prExists === false` → `no_pr`
2. `prMerged || prClosed` → `done`
3. `prDraft` → `pr_draft`
4. `copilotReviewRequestStatus === "unavailable"` → `review_request_unavailable`
   *(only reached when no in-progress evidence was found; the request helper returns `already-requested` instead when Copilot review is observably in progress before or after known unavailable/unrequestable failures, including the 422 collaborator case)*
5. `copilotReviewRequestStatus === "failed"` → `blocked_needs_user_decision`
6. `(unresolvedThreadCount > 0 || copilotBodyFeedbackUnresolved) && agentFixStatus === "applied"` → `already_fixed_needs_reply_resolve`
7. `unresolvedThreadCount > 0 || copilotBodyFeedbackUnresolved` → `unresolved_feedback_present`
   *(Unresolved feedback always takes priority over any wait/watch path. A body-only Copilot finding — `copilotBodyFeedbackUnresolved` true with zero inline threads — routes here too, and likewise keeps the round-cap `cleanThreads` check and `ready_to_rerequest_review` clean-convergence from treating the head as clean)*
8. `copilotReviewRequestStatus === "requested" || copilotReviewRequestStatus === "already-requested"` → `waiting_for_copilot_review`
   *(A current-head Copilot review request is still active or pending; the wait is not concluded until that request status settles, even when a submitted current-head review is already visible.)*
9. `copilotReviewPresent && (ciStatus === "failure" || (copilotReviewOnCurrentHead && copilotPriorHeadBodyFeedbackUnresolved))` → `blocked_needs_user_decision`
   *(The second clause: a later body-only finding on an earlier commit outranks a clean current-head review. A re-request stops at the same-head clean suppression, so the loop reports blocked and `copilotBodyDispositionRequired` names the review a record must name. The CI opt-out below does not skip this clause.)*
10. `copilotReviewPresent && (ciStatus === "pending" || ciStatus === "none")` → `waiting_for_ci`
11. `copilotReviewPresent` → `ready_to_rerequest_review`
12. `ciStatus === "failure"` → `blocked_needs_user_decision`
13. `ciStatus === "pending" || ciStatus === "none"` → `waiting_for_ci`
14. Default → `pr_ready_no_feedback`

> **Pre-approval CI opt-out (#1337).** Rules 9/10/12/13 above are gated by `refinementConfig.preApprovalRequireCi` (default `true`). When a repo sets `gates.preApproval.requireCi: false`, a non-draft PR (already past the draft gate) treats a `failure`/`pending`/`none` CI verdict as non-blocking. The opt-out skips only the CI clauses of these four rules, so routing falls through to `ready_to_rerequest_review` (rule 11) / `pr_ready_no_feedback` (rule 14). Rule 9's prior-head body-feedback clause is not a CI clause. It still applies under the opt-out and still routes to `blocked_needs_user_decision`. The draft-gate CI path is unaffected (a draft PR short-circuits to `pr_draft` before these rules).

When rule 11 yields `ready_to_rerequest_review`, the interpreter also emits two behavioral indicators:

- Automatic re-request eligibility — available only when a meaningful remediation event has occurred since the last Copilot review basis (deterministically: there is no submitted Copilot review on the current head).
- Clean convergence on current head — when the current head already has a clean submitted Copilot review and no unresolved threads remain, automatic same-head re-request is suppressed.

## Key Behavioral Guarantees

### Unresolved feedback always routes to fix/reply-resolve — never to wait

<!-- rule: COPILOT-STATE-UNRESOLVED-PRIORITY -->
`COPILOT-STATE-UNRESOLVED-PRIORITY`: Rules 6 and 7 MUST check `unresolvedThreadCount > 0` before checking review-request status (rule 8); even while Copilot is currently in `requested_reviewers`, unresolved threads from a prior review MUST take priority and route the loop into fix/reply-resolve work.

### Active current-head request state keeps the wait open

<!-- rule: COPILOT-STATE-ACTIVE-REQUEST-WAIT -->
`COPILOT-STATE-ACTIVE-REQUEST-WAIT`: Rule 8 MUST route to `waiting_for_copilot_review` whenever the effective request status is `requested` or `already-requested`. A submitted (non-PENDING) Copilot review on the current head is necessary evidence for clean convergence, but it is not sufficient while the request remains active. This reconciliation is shared (issue #1588): `resolveCopilotReviewRequestStatus` in `scripts/loop/_copilot-review-request-status.mjs` is the single derivation path for `copilotReviewRequestStatus` across `detect-copilot-loop-state.mjs`, `detect-pr-gate-coordination-state.mjs`, and `request-copilot-review.mjs`. It resolves an ambiguous `requested_reviewers` entry (Copilot listed AND a submitted current-head review exists with no PENDING review) by comparing the latest `review_requested` timeline event timestamp against the latest submitted review timestamp: if the request is newer than the review, the request is genuinely active and the status stays `requested`; if the request predates the review, it is stale and settles to `none`. When the timeline is unavailable, the derivation fails closed to `requested`. A settled (`none`) status lets the loop proceed from `ready_to_rerequest_review` to `pre_approval_gate` instead of dead-ending into `stop`. The loop falls through to rule 9+ only after the current-head request status settles to `none` or another non-active terminal status.

### Automatic same-head re-request suppression after clean convergence

When the current head already has a submitted Copilot review, the unresolved thread count is 0, and CI is not in a blocked wait/failure state, automatic follow-up re-request is suppressed for that head (clean convergence on current head, automatic re-request suppressed). Automatic re-request becomes eligible again only after a meaningful remediation event changes the review basis (for this loop: a newer head without a submitted Copilot review on that head). Explicit operator/manual re-request remains allowed, but the direct request helper now suppresses same-head clean re-requests by default unless `--force-rerequest-review` is provided.

Clean convergence is a behavioral indicator (`sameHeadCleanConverged`) emitted while the state remains `ready_to_rerequest_review` — it is not a transition to `done` or `pre_approval_gate`. The handoff to `pre_approval_gate` is owned by the broader PR-lifecycle/gate-coordination layer, which consumes the `sameHeadCleanConverged` indicator (and the shared `resolveCopilotReviewRequestStatus` reconciliation that settles a stale `requested` status to `none` when the request predates the latest same-head submitted review) to grant `RUN_PRE_APPROVAL_GATE` instead of dead-ending into `stop` (#1588).

### Carried convergence after a post-convergence head bump

<!-- rule: COPILOT-STATE-CARRIED-CONVERGENCE -->
`COPILOT-STATE-CARRIED-CONVERGENCE`: A head without its own Copilot review MUST carry the latest converged Copilot review forward only when all of these hold: no Copilot review request is outstanding; the latest submitted Copilot review is on an earlier head; zero review threads are unresolved; and that review is not a body-only changes-recommended or unrecognized review, unless it opened at least one thread of its own (attributed through the thread's root comment `pullRequestReview.id`; a thread without that attribution never counts) or a trusted disposition record (`COPILOT-STATE-BODY-DISPOSITION-RECORD`) names that review for the current head. A body-only `🔵` review carries without a record, as at the merge gate. The latest review always decides: an earlier converged review never holds against a later Copilot review. The mode comes from `refinement.requireCopilotConvergenceAtLatestHead` (ADR 0090). In the default converged-once mode (`false`), the delta since the latest review is not checked, and the loop MUST NOT open a new Copilot cycle on a carried head: `request-copilot-review.mjs` returns `suppressed_post_convergence` below the cap, at the cap, and under `--force-rerequest-review`, and neither the detector nor `copilot-pr-handoff.mjs` reopens the cycle at the round cap. In the strict mode (`true`), the current head MUST also advance linearly from the reviewed head and the delta MUST be provably docs-only or integrate-only (base-relative reduction empties it); the request tool then returns `suppressed_post_convergence_docs_only`, and a significant change reopens the cycle at the round cap. `request-copilot-review.mjs`, `detect-pr-gate-coordination-state.mjs`, `copilot-pr-handoff.mjs`, and `merge-pr.mjs` MUST decide this through the one shared predicate in `scripts/loop/_copilot-convergence-carry.mjs`, and each reads the mode through `resolveRequireCopilotConvergenceAtLatestHead` in `@dev-loops/core/config`. The request tool never re-requests on a head the detector reports as carried, and the detector never reports carried on a head where the request tool would re-request. The detector feeds the result to the evaluator as `postConvergenceReviewSuppressed` and emits it as `carriedConvergence` (`source` `converged_once`, `carried`, or `marker`, `sourceReviewId`, `sourceHeadSha`, `reason`, `bodyDisposition`; `null` when not carried). Any unresolved thread MUST re-open the Copilot round in both modes; in the strict mode a non-docs-only or unproven delta MUST too. The operator suppression marker written by `withdraw-copilot-review-request.mjs` MUST be honored only under the request-status, thread, docs-only delta, and body-only checks. `merge-pr.mjs` MUST grant `converged_once` (default mode) or `docs_only_suppression` (strict mode) through the same predicate, and its merge result names the carried review as `copilotCarriedConvergence` (`source`, `sourceReviewId`, `sourceHeadSha`, `bodyDisposition`).

### Body-only Copilot feedback disposition record

<!-- rule: COPILOT-STATE-BODY-DISPOSITION-RECORD -->
`COPILOT-STATE-BODY-DISPOSITION-RECORD`: A body-only Copilot finding (`copilotBodyFeedbackUnresolved` with no inline thread to reply to or resolve) MUST clear only through a PR issue comment that carries one of these markers:

```text
<!-- dev-loops:copilot-body-disposition review=<review id> head=<40-hex current head> fix=<40-hex commit> -->
<!-- dev-loops:copilot-body-disposition review=<review id> head=<40-hex current head> operator -->
```

`review` is the Copilot review's GraphQL node id as `gh pr view --json reviews` reports it, compared case-sensitively. `head` MUST equal the current head. `fix` names the fixing commit, which MUST be strictly after the dispositioned review's commit (the compare from the review commit to the fix commit reports `ahead`) and MUST be the head or one of its ancestors. A `fix` record therefore never clears a finding on a review of the current head; only the `operator` form can. The `operator` form is reserved for a human operator decision; agents, the fixer included, write only the `fix` form. `merge-pr.mjs` reads the record through the same resolver, so a current-head finding cleared by an `operator` record also clears `copilot_convergence` at merge, and the merge result names the record as `copilotBodyDisposition`. A marker inside a fenced code block, an inline code span, or a `>` quote line is never a record. The comment author MUST be a human with `OWNER`, `MEMBER`, or `COLLABORATOR` association; bot logins, Copilot included, are never trusted. A trusted record that names the current-head review which raised the finding clears `copilotBodyFeedbackUnresolved` in `detect-copilot-loop-state.mjs`, `detect-pr-gate-coordination-state.mjs`, and `request-copilot-review.mjs` (one shared resolver in `scripts/github/_copilot-body-disposition.mjs`) and clears the gate-entry body block, for that head only, so `round_cap_clean_fallback` becomes reachable at the round cap. The same resolver covers an earlier-head finding: when the latest Copilot review sits on an earlier head and is body-only changes-recommended or unrecognized with no thread of its own, it sets `copilotPriorHeadBodyFeedbackUnresolved`, and at the round cap that blocks `round_cap_clean_fallback` until a trusted `fix` record (fix commit after that review's commit and in the head) or `operator` record names that review for the current head. Two or more tied latest reviews with a body finding have no single owner, so no record clears them. The gate coordination output records the record used as `copilotBodyDisposition`. While either flag blocks, it emits `copilotBodyDispositionRequired` (`reviewId`, `reviewCommitSha`, `reason`) to name the review a record must name; `reviewId` is `null` for a tie that no record clears, and the field is `null` when neither flag blocks. No record, a record for another head, a different review id, an untrusted author, an unreachable fix commit, or an unreadable comment stream MUST leave the finding blocking. No tool writes this record automatically; the operator posts the `operator` form and the fixer posts the `fix` form.

### `unavailable` stops the loop only when no in-progress evidence exists

Rule 4 routes to `review_request_unavailable` when the explicit request path returned `unavailable`. However, this only reaches the state machine when there is **no observable in-progress evidence**. The request helper (`request-copilot-review.mjs`) short-circuits to `already-requested` when Copilot review is already observably in progress before the mutation attempt, and it also performs post-failure verification after known unavailable/unrequestable failures (including the 422 collaborator error): if Copilot is found in `requested_reviewers` or has a PENDING review pinned to the current head commit, it returns `already-requested` instead of `unavailable`. The auto-detect path also treats a PENDING Copilot review on the current head as equivalent evidence to being in `requested_reviewers`, setting `copilotReviewRequestStatus = "requested"`.

The net effect: `unavailable` in the snapshot means the request path failed **and** Copilot is observably not in progress. The loop never drops to the approval gate when Copilot review is still in progress.

### `failed` and plain `unavailable` stop the loop immediately

<!-- rule: COPILOT-STATE-TERMINAL-STOP -->
`COPILOT-STATE-TERMINAL-STOP`: Rules 4 and 5 MUST check for terminal review-request failures before any other non-closed state; the loop MUST NOT fall through to `waiting_for_copilot_review` or `waiting_for_ci` when the review request has definitively failed with no in-progress evidence.

### Incomplete review-thread detection blocks auto-detect

Auto-detect must fail closed when review-thread state cannot be captured or parsed. The detector must not synthesize `unresolvedThreadCount: 0` from a GitHub or parser failure, because that could hide unresolved feedback and produce an unsafe wait or re-request recommendation.

### Reply/resolve must precede re-request

<!-- rule: COPILOT-STATE-REPLY-BEFORE-REREQUEST -->
`COPILOT-STATE-REPLY-BEFORE-REREQUEST`: `already_fixed_needs_reply_resolve` MUST transition only to `ready_to_rerequest_review`, never directly to `waiting_for_copilot_review`; the agent MUST explicitly resolve threads on GitHub (via `scripts/github/reply-resolve-review-thread.mjs`) before triggering the next Copilot pass.

### Green validation precondition before follow-up re-request

Re-requesting Copilot after a follow-up fix is gated on the updated head being green or credibly green. In practice:

- run the smallest honest local validation for the accepted fix scope
- continue remediation if that local validation is still known red
- after a fix push advances the PR head SHA, treat previous-head CI evidence as stale for CI-dependent follow-up
- refresh the relevant GitHub CI/check state for the current head before advancing
- treat `ciStatus: "pending"` and `ciStatus: "none"` for the current head as wait states, not as green
- passing local validation alone does not satisfy a follow-up step that still requires GitHub CI/check readiness for the current head
- only current-head results may satisfy that CI-dependent step; older-head results must not unblock the new head
- continue remediation if CI/checks for the current head are known red for a fixable issue
- if waiting for current-head checks times out before they settle, remain waiting/blocked rather than crossing the CI-dependent boundary anyway

### `waiting_for_copilot_review` is a persistence boundary for explicit async loop entry

<!-- rule: COPILOT-STATE-WATCH-PERSISTENCE -->
`COPILOT-STATE-WATCH-PERSISTENCE`: When a user explicitly asks to enter or continue the async Copilot dev loop, landing on `waiting_for_copilot_review` MUST keep the loop in watch mode (the continuation-not-completion core is owned by [`STOP-COPILOT-REVIEW-001`](./stop-conditions.md), quiet observations by [`STOP-QUIET-WATCHER-001`](./stop-conditions.md)). This rule owns watch REATTACHMENT: after a quiet `timeout`/`idle`, refresh deterministic state and, if it remains `waiting_for_copilot_review` (or another non-terminal wait state), keep the async watcher attached; after a successful narrow follow-up fix / reply-resolve / re-request cycle that returns to `waiting_for_copilot_review`, resume watch mode instead of treating the re-request handoff as the end of the async run. Handoff-only behavior is a separate, narrower contract and MUST be explicitly requested.

## Normal request/watch routing contract

The normal request/re-request/watch routing seam is helper-owned in `scripts/loop/copilot-pr-handoff.mjs` (not markdown-owned). Use its machine-readable output as the contract:

- top-level `action`, `nextAction`, `reviewRequestStatus`, `watchArgs`, `loopDisposition`, `terminal`
- `requestWatchContract.routingState` (`ready_state_needs_copilot_request`, `copilot_request_confirmed_waiting`, `draft_reset_requires_ready_state_reentry`, `non_ready_state`)
- `requestWatchContract.stopState` for explicit stop/blocked routing (`unavailable`, `blocked`, `draft_requires_ready_state_reentry`, `no_automatic_next_step`)

Skills and operational docs should reference this helper contract for deterministic branching and reserve markdown for policy/operator judgment.

## Related Scripts

| Script | Purpose |
|---|---|
| `scripts/loop/detect-copilot-loop-state.mjs` | Current-state detection and snapshot interpretation (this machine) |
| `scripts/github/request-copilot-review.mjs` | Request or detect Copilot review; its `status` output maps to `copilotReviewRequestStatus` |
| `scripts/github/probe-copilot-review.mjs` | Watch for fresh Copilot review activity (use in `waiting_for_copilot_review`) |
| `scripts/github/capture-review-threads.mjs` | Capture and normalize review threads; provides `unresolvedThreadCount` / `actionableThreadCount` |
| `scripts/github/reply-resolve-review-thread.mjs` | Reply to and resolve a single review thread (use in `already_fixed_needs_reply_resolve`) |
