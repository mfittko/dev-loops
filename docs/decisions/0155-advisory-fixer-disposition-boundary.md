# 0155. The fixer-disposition boundary is advisory

## Status

Accepted — 2026-10-18 ([issue 2817](https://github.com/mfittko/dev-loops/issues/2817))

## Context

Amends [0146](./0146-read-only-active-fixer-obligation-check.md) and [0068](./0068-fixer-disposition-fail-closed-boundary.md): they decided that an incomplete or unverified full fixer disposition blocks gate coordination and Copilot requests with next action `complete_fixer_disposition`. It also amends [0131](./0131-pre-push-delta-thread-route-and-decision-record.md): only its "Related boundary" statement that `request-copilot-review.mjs` refuses while the fixer disposition is incomplete is superseded. Records 0146, 0068 and 0131 stay unedited. <!-- secret-scan:allow ADR file link, not a credential -->

The block has no sanctioned exit. A disposition binds to one exact head, one exact plan and one post-pull handoff. Normal workflow events break that binding and nothing reopens it: a CI-fix commit after construct or verify, a fixer that skipped `--construct` and hand-wrote its handoff, and a re-emission that superseded the active plan. In one day of the v1.0.7 drain, five PRs deadlocked or nearly deadlocked. The recovery producer, issue 2787, is cut from v1.0.6.

The numbering check fetched origin and found open PRs holding 0154, so this record uses 0155.

## Decision

`resolveFixerDispositionInput` keeps the `incomplete` detail for an incomplete disposition and adds a `warning`. It returns `nextAction: null` and empty `forbiddenActions`. Gate coordination and `request-copilot-review.mjs` proceed with their normal next action and surface the warning (the incomplete thread ids and their failed steps) in their output. `verify-fixer-disposition.mjs` stays as an optional tool.

Merge safety is unchanged. `merge-pr` still requires zero unresolved review threads and both gates clean at the merge head. Every new head still gets a full gate round. The work-order chain (emission, pull receipts, construct, verifier) stays as it is, and no recovery producer is added.

## Consequences

An incomplete disposition no longer stops a PR, and the warning keeps it visible. The weaker guarantee is a stopgap: the v1.0.8 redesign builds the fixer lifecycle from liveness, gives every fail-closed state a tested sanctioned exit, and has tooling produce the fixer report. Consumers need this before 2026-10-28, so it ships as a stable patch on 1.0.6.
