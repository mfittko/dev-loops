# 0240. The Copilot reviewer is matched by its exact login

## Status

Accepted — 2026-11-03 ([issue 3034](https://github.com/mfittko/dev-loops/issues/3034), operator-reported).

Amends [ADR 0233](./0233-fixer-work-order-from-review-body.md) and extends [ADR 0238](./0238-comment-text-from-non-maintainers-never-reaches-an-agent.md). Accepted records remain unchanged.

## Context

ADR 0233 identifies the Copilot author of a review body with `isCopilotLogin`, a prefix match on `copilot`. ADR 0233 governs only that review-body author check, and `resolveLatestCopilotReview` already uses the exact match. Any account named `copilot-...` passes the prefix match, so a lookalike account can present its text as Copilot review output at the other reviewer sites. ADR 0238 defines `isSanctionedCopilotReviewerLogin`, an exact match on the Copilot pull-request reviewer.

## Decision

This ADR amends ADR 0233 and extends ADR 0238 by applying the same exact match, `isSanctionedCopilotReviewerLogin` from `packages/core/src/github/comment-trust.mjs`, at every site that decides whether an author is the Copilot reviewer: `probe-copilot-review`, `request-copilot-review`, `withdraw-copilot-review-request`, `copilot-loop-iterations` (reviewer, request and review-comment filters), `resolveCopilotReviewPresence`, `_copilot-review-request-status` and the requested-reviewer timeline check in `detect-pr-gate-coordination-state`. The probe also gates review and conversation text on the ADR 0238 trust predicate. The REST login `Copilot` and the GraphQL login `copilot-pull-request-reviewer` (with or without `[bot]`) both match.

`isCopilotLogin` stays at these sites:

- `merge-pr`: it fails closed, so the broader match is the safe side.
- Coding-agent ownership checks: they must also recognise `copilot-swe-agent`.
- The commit-author filter: it excludes `copilot-swe-agent` commits.
- Thread classification: it must recognise every Copilot account.
- `unresolve-review-thread`: it must act on threads from any Copilot account.
- `authorMatchesFilter` in `_review-thread-mutations` (the `copilot` author filter of `reply-resolve-review-threads` and `list-review-threads`): like thread classification, the filter must select threads from every Copilot account so that none is skipped.
- Startup ownership: it must recognise the coding agent.
- Human-approval exclusions (`isNonHumanLogin` in `merge-approval` and the human review filter in `size-budget-merge-gate`): they exclude every Copilot account from human-approval counting, so the broader match is the fail-closed side. An exact match would let a `copilot-x` account count as a human approver.
- `copilot-pr-handoff` (last-bot-action baseline and human-comment exclusion): the broader match is the fail-safe side for exclusion, so a `copilot-*` account never counts as operator input.

## Consequences

A `copilot-x` account no longer counts as the Copilot reviewer for requests, withdrawals, presence, iteration counts or probe output. The probe no longer reports coding-agent (`copilot-swe-agent`) activity as reviewer activity. `checkForCopilotComments` now treats a comment from a non-sanctioned `copilot-*` account that contains a bare `@copilot` as a summon violation. Two predicates remain, each with a distinct purpose: the exact reviewer match and the coding-agent prefix match.
