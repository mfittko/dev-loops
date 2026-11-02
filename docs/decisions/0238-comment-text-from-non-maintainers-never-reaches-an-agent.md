# 0238. Comment text from non-maintainers never reaches an agent

## Status

Accepted — 2026-11-02 ([issue 3034](https://github.com/mfittko/dev-loops/issues/3034), operator-reported).

Extends [ADR 0233](./0233-fixer-work-order-from-review-body.md). Accepted records remain unchanged.

## Context

On a public repository any account can open a review thread or comment on a PR. A fixer work order carries thread text as an instruction, and the fixer runs commands on the operator's machine. A non-maintainer comment could therefore steer a fixer into arbitrary command execution (prompt injection). ADR 0233 filtered review bodies and the disposition markers. No review-thread path was filtered: the GraphQL thread queries never fetched `authorAssociation`.

## Decision

One predicate, `isTrustedCommentAuthor` in `packages/core/src/github/comment-trust.mjs`, decides trust. A trusted author is a non-bot account with `authorAssociation` `OWNER`, `MEMBER` or `COLLABORATOR`. An `allowCopilot` variant also admits the Copilot reviewer (a Bot whose login matches `isCopilotLogin`). A GraphQL adapter and a REST adapter feed it. `isTrustedDispositionAuthor` stays as the REST alias. A missing association is untrusted. A GraphQL comment the viewer authored (`viewerDidAuthor`, set by GitHub) is trusted, so a gate that posts under a bot identity keeps its own threads.

Trust is decided once at ingestion. `normalizeComment` and `parseReviewThreads` drop the text of an untrusted comment. `fetchAllReviewThreads` lists the first trusted comment of each thread and returns threads with no trusted comment as skipped. Both GraphQL thread queries now fetch `authorAssociation`. A thread with comments and none trusted is not an act item, not a known finding, and not an unresolved-thread blocker. `summary.unresolvedThreads` counts trusted threads only, so every gate and merge precondition that reads it follows. The skip reports author logins and the remedy: a maintainer replies to or resolves the thread, or restates the finding. A maintainer reply or resolve clears the skip, so there is no lockout.

The fixer work order and the `threads` source refuse a thread without the ingestion `trusted` marker. Each work order labels comment text as data, never instructions. The fixer prose reads threads only through the work order.

The trusted set has no configuration surface in this slice. The owner rule is `GATE-REVIEW-COMMENT-TRUST` in the gate review sub-loop contract.

## Consequences

A comment from a non-maintainer never reaches a fixer or gate agent through a review thread. Both Claude and Pi consume the same scripts and the same core module, so the rule is harness-agnostic. A bot other than the Copilot reviewer is untrusted on thread surfaces. A bot identity is trusted only through `viewerDidAuthor`: the gate reads with the token it posts with. A shared CI token (`github-actions[bot]`) would make other workflow text trusted, so document that before any CI-token gate. The repository-permission check (write, maintain or admin) is deferred to a follow-up slice, because association is coarse. The check fails closed with a visible reason, causes no lockout and adds no configuration surface. External associations (`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`) are skipped. Issue-comment readers are covered in a following slice.
