# 0073. A new gate verdict folds the same gate's superseded prior-head verdict reviews as Outdated

## Status

Accepted — 2026-09-17 ([PR 2258](https://github.com/mfittko/dev-loops/pull/2258))

## Context

Each gate round posts one `### Gate review: <gate>` summary review at that round's head ([0046](./0046-one-review-surface-per-gate-round.md)). When the head moves, the prior round's verdict review does not go anywhere — it stays expanded in the PR conversation. A multi-round `draft_gate`/`pre_approval_gate` therefore accumulates one stale `findings_present` verdict review per prior head; on PR 2247 this reached six stacked verdict reviews before they were minimized by hand. GitHub's own answer for a superseded review is `minimizeComment(classifier: OUTDATED)`, and a `PullRequestReview` body is Minimizable. [Issue 2257](https://github.com/mfittko/dev-loops/issues/2257) ordered the stale verdicts folded automatically.

## Decision

After `upsert-checkpoint-verdict.mjs` creates a new `draft_gate` (resp. `pre_approval_gate`) verdict, it folds the SAME gate's prior verdict reviews recorded at EARLIER heads via `minimizeComment(classifier: OUTDATED)` (`GATE-COMMENT-SUPERSEDE-OUTDATED`, `skills/docs/gate-review-comment-contract.md`). Selection keys on "not the current head", so a force-pushed-away head is folded too; it never touches the just-posted current-head verdict or the other gate's verdicts, skips already-minimized reviews (idempotent), and is bounded by a cap (default 50) that reports an overflow rather than fanning out unbounded. The fold is best-effort and fail-open: any failure — rate limit, permissions, a single failed minimize — is swallowed into a `minimizeWarning` on the result and never fails the authoritative verdict post. It runs only when the poster already holds evidence of a prior same-gate verdict at a different head, so a first-ever verdict adds no GraphQL call. Rejected: dismissing the prior reviews (`dismissPullRequestReview` changes review state and reads as "this no longer counts" — it re-litigates the record; minimizing only collapses, reversibly, leaving the audit trail intact); folding the inline finding comments too (GitHub already badges those Outdated and collapses resolved threads, so the summary reviews are where the visible noise concentrates — a separate, larger, opt-in sweep with its own budget cost).

## Consequences

The PR conversation collapses to one expanded verdict review per gate — the current head's — with every superseded round folded but recoverable. The fold reuses the poster's existing prior-verdict discovery rather than a second scan, and its fail-open contract keeps hiding stale noise from ever blocking an evidence write. Two costs are accepted. The sweep enumerates the PR's first 100 reviews in one page, so a PR with more than 100 reviews would not fold beyond that (no such PR exists today, and the poster's own listing has the same bound). And the fold is best-effort: when it fails it leaves the stale verdicts expanded and surfaces a `minimizeWarning`, rather than retrying or failing the round.
