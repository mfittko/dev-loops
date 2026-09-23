# 0085. Make the pre-PR review trigger route-neutral

## Status

Accepted — 2026-09-23 ([issue #2357](https://github.com/mfittko/dev-loops/issues/2357), [PR 2386](https://github.com/mfittko/dev-loops/pull/2386))

Amends the placement of [0079](./0079-pre-pr-review-phase.md). It keeps the rest of that decision and [0082](./0082-pre-pr-reviewer-opus.md) unchanged.

## Context

ADR 0079 placed the pre-PR review phase in the local-implementation loop, as step 11b (`LOCAL-PRE-PR-REVIEW-BEFORE-PUSH`). Step 11b's wording scopes the trigger to "any session that pushes and opens a PR", but the contract rule and the phase's reachability limited it to the local route. A session on a GitHub-first route (`issue_intake`, `copilot_pr_followup`, `external_pr_followup`, `reviewer_fixer`, `final_approval`) never loads the local-implementation skill, so a GitHub-first session that created its own branch and PR skipped the phase. Evidence: the session for PR 2356 was routed `copilot_pr_followup`, created the PR, and made no pre-PR dispatch.

## Decision

The trigger is a session property: the session pushes and opens a PR. `PRE-PR-BEFORE-FIRST-PUSH` in `skills/docs/pre-pr-review-contract.md` is route-neutral. The GitHub-first routes reach the existing step at `OPS-DRAFT-FIRST-PR` in `skills/docs/copilot-loop-operations.md`, before the first push and before `create-pr.mjs`. The `issue_intake` route, which starts with no PR, also lists the contract in its startup required reads. The follow-up routes do not, because they normally start on an existing PR; a follow-up-route session that creates its own PR reaches the contract through the `OPS-DRAFT-FIRST-PR` link. Step 11b stays the local route's instance of the same step. The review itself is unchanged: one fresh-context reviewer, at most two rounds, ephemeral, and never gate evidence.

We rejected a new review stage or a second dispatch, because the existing step already covers the need. We rejected moving the local rule out of the local-implementation skill, because the local route already reaches it. We rejected a mechanical check in `create-pr.mjs`, because 0079 already rejected mechanical enforcement of the phase.

## Consequences

Every session that creates a PR makes one pre-PR review call, on any route. Sessions on a Copilot-authored PR and follow-up sessions on an existing PR open no PR, so they have no pre-PR step and are unaffected. `test/contracts/pre-pr-review-contract.test.mjs` pins the route-neutral scope, the `OPS-DRAFT-FIRST-PR` reference, and the route-table reachability.
