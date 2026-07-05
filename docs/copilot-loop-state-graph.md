# Copilot Loop State Graph

This document defines the deterministic state machine for the async Copilot review/fix loop.

## Overview

The state machine captures observable PR/GitHub/worktree facts (the **snapshot**) and maps them to exactly one **current state**, a list of **allowed next transitions**, and a **recommended next action**.

This document is the Copilot-family inner-loop state machine. The broader family-local PR lifecycle that consumes this machine is defined in [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md).

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
| `done` | PR has been merged or closed |
| <!-- term: state:internal_tooling_direct_gate --> `internal_tooling_direct_gate` | Internal-tooling-only PR; Copilot external review is skipped and the loop proceeds directly to `pre_approval_gate` |

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
6. `unresolvedThreadCount > 0 && agentFixStatus === "applied"` → `already_fixed_needs_reply_resolve`
7. `unresolvedThreadCount > 0` → `unresolved_feedback_present`
   *(Unresolved feedback always takes priority over any wait/watch path)*
8. `copilotReviewRequestStatus === "requested" || copilotReviewRequestStatus === "already-requested"` → `waiting_for_copilot_review`
   *(A current-head Copilot review request is still active or pending; the wait is not concluded until that request status settles, even when a submitted current-head review is already visible.)*
9. `copilotReviewPresent && ciStatus === "failure"` → `blocked_needs_user_decision`
10. `copilotReviewPresent && (ciStatus === "pending" || ciStatus === "none")` → `waiting_for_ci`
11. `copilotReviewPresent` → `ready_to_rerequest_review`
12. `ciStatus === "failure"` → `blocked_needs_user_decision`
13. `ciStatus === "pending" || ciStatus === "none"` → `waiting_for_ci`
14. Default → `pr_ready_no_feedback`

When rule 11 yields `ready_to_rerequest_review`, the interpreter also emits two behavioral indicators:

- Automatic re-request eligibility — available only when a meaningful remediation event has occurred since the last Copilot review basis (deterministically: there is no submitted Copilot review on the current head).
- Clean convergence on current head — when the current head already has a clean submitted Copilot review and no unresolved threads remain, automatic same-head re-request is suppressed.

## Key Behavioral Guarantees

### Unresolved feedback always routes to fix/reply-resolve — never to wait

<!-- rule: COPILOT-STATE-UNRESOLVED-PRIORITY -->
`COPILOT-STATE-UNRESOLVED-PRIORITY`: Rules 6 and 7 MUST check `unresolvedThreadCount > 0` before checking review-request status (rule 8); even while Copilot is currently in `requested_reviewers`, unresolved threads from a prior review MUST take priority and route the loop into fix/reply-resolve work.

### Active current-head request state keeps the wait open

<!-- rule: COPILOT-STATE-ACTIVE-REQUEST-WAIT -->
`COPILOT-STATE-ACTIVE-REQUEST-WAIT`: Rule 8 MUST route to `waiting_for_copilot_review` whenever the effective request status is `requested` or `already-requested`. A submitted (non-PENDING) Copilot review on the current head is necessary evidence for clean convergence, but it is not sufficient while the request remains active. The auto-detect path resolves an ambiguous `requested_reviewers` entry (Copilot listed AND a submitted current-head review exists with no PENDING review) by comparing the latest `review_requested` timeline event timestamp against the latest submitted review timestamp: if the request is newer than the review, the request is genuinely active and the status stays `requested`; if the request predates the review, it is stale and settles to `none`. When the timeline is unavailable, the detector fails open and trusts `requested_reviewers` as authoritative. The loop falls through to rule 9+ only after the current-head request status settles to `none` or another non-active terminal status.

### Automatic same-head re-request suppression after clean convergence

When the current head already has a submitted Copilot review, the unresolved thread count is 0, and CI is not in a blocked wait/failure state, automatic follow-up re-request is suppressed for that head (clean convergence on current head, automatic re-request suppressed). Automatic re-request becomes eligible again only after a meaningful remediation event changes the review basis (for this loop: a newer head without a submitted Copilot review on that head). Explicit operator/manual re-request remains allowed, but the direct request helper now suppresses same-head clean re-requests by default unless `--force-rerequest-review` is provided.

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
`COPILOT-STATE-WATCH-PERSISTENCE`: When a user explicitly asks to enter or continue the async Copilot dev loop, `waiting_for_copilot_review` is a persistence boundary for explicit async loop entry: landing on it MUST keep the loop in watch mode rather than reporting completion. Quiet watcher results such as `timeout` or `idle` are observational only: refresh deterministic state, and if the state remains `waiting_for_copilot_review` (or another non-terminal wait state) keep the async watcher attached. The same rule applies after a successful narrow follow-up fix / reply-resolve / re-request cycle: if the next deterministic state returns to `waiting_for_copilot_review`, resume watch mode again instead of treating the re-request handoff as the end of the async run. Handoff-only behavior is a separate, narrower contract and must be explicitly requested.

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
