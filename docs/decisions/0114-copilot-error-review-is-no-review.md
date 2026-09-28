# 0114. A Copilot error review is no Copilot review

## Status

Accepted — 2026-09-28 ([issue 2549](https://github.com/mfittko/dev-loops/issues/2549))

Amends [ADR 0090](./0090-copilot-converged-once-default.md): that record lists a headerless Copilot review body as converged. This record excludes one headerless body, the Copilot error text, from every Copilot review rule.

## Context

On PR 2547, Copilot posted a `COMMENTED` review with 0 threads on the current head. The body was "Copilot encountered an error and was unable to review this pull request. You can try again by re-requesting a review." The body has no disposition header, so `classifyCopilotReviewBodyDisposition` returned `none`. `evaluateCopilotConvergence` read `none` as `current_head_clean`, the loop reported `clean_converged`, and `merge-pr` merged. No Copilot review took place. The same review also counted as a completed Copilot round and could be carried to a later head as `converged_once`.

## Decision

- `COPILOT_DISPOSITION.REVIEW_ERROR` (`review_error`) is a new disposition. `classifyCopilotReviewBodyDisposition` returns it for a `COMMENTED` review whose body has no `### ` disposition header and whose trimmed body starts with `Copilot encountered an error` (case-insensitive). The header check runs first, so a body with a disposition header never classifies as `review_error`. Every other headerless body keeps `none`.
- `isCopilotErrorReview(review)` in `copilot-helpers.mjs` is the one predicate. It reads `state` and `body` from the GraphQL and REST review shapes.
- A review that classifies as `review_error` is not a submitted Copilot review for the latest-review rule, the converged predicate, the round count and the current-head facts. `evaluateCopilotConvergence`, `summarizeCopilotReviews` and `resolveLatestCopilotReview` skip it. A head whose only Copilot reviews are error reviews reports `no_current_head_review`, which passes only through a sanctioned absent-review disposition. `summarizeCopilotReviews` keeps the review in `copilotReviews`, `copilotReviewIds` and `copilotReviewPresent`.
- Bounded retry. `buildSnapshotFromPrFacts` derives `copilotErrorReviewCountOnCurrentHead`. With no non-error submitted Copilot review on the current head and no outstanding request, one error review keeps the normal routing, so the request tool makes one same-head re-request. Two or more route to `blocked_needs_user_decision`.

Rejected: failing closed on every headerless `COMMENTED` body with 0 threads (it would block legitimate legacy and empty clean reviews); matching other Copilot failure texts before they are observed.

## Consequences

A Copilot error no longer merges a PR without a Copilot review. The loop re-requests once on the same head, then asks the operator to push a new head or re-run the request wrapper. `merge-pr` reports `copilotConvergenceState: no_current_head_review` for a refused merge and adds no output field. Other Copilot failure texts keep `none` until a follow-up adds them from observed evidence.
