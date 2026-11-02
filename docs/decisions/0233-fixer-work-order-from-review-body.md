# 0233. A fixer work order can come from one review body

## Status

Accepted — 2026-11-02. Amends [ADR 0107](0107-fixer-mutation-authority-bound-to-pulled-work-order.md) (the decision there names two fixer sources; this record adds a third).

## Context

Issue [2548](https://github.com/mfittko/dev-loops/issues/2548) describes feedback that lives only in the body of a PR review. No inline thread exists, so `emit-fixer-work-order.mjs` has no source for it, and the fixer write guard correctly denies the first edit. The deny message does not say how a coordinator obtains a work order.

## Decision

- `emit-fixer-work-order.mjs` accepts `--review-id <review node id>` as a third source. Exactly one of `--act-list-file`, `--threads-file` and `--review-id` is required. `--gate` and `--delta-result` stay valid only with `--act-list-file`.
- The emitter reads the review through `gh api .../pulls/<pr>/reviews --paginate` and matches `node_id`. It refuses an unknown review, a state other than `CHANGES_REQUESTED` or `COMMENTED`, an empty body and any bot other than the Copilot reviewer.
- Human author: `author_association` must be `OWNER`, `MEMBER` or `COLLABORATOR`, and the review commit must be the PR head or an ancestor of it. A human review body does not go stale on a push.
- Copilot author: identified by `isCopilotLogin` on the REST login with REST `user.type` `Bot`. The review is valid only when `resolveLatestCopilotReview` selects it and its `commit_id` equals the current PR head. An ambiguous blocking tie refuses. The association check does not apply.
- The emitter writes an immutable snapshot `review-body.json` (review ID, state, commit, author, association, body, `bodySha256`) as the one required read of kind `review-body`. One review body is one act item. The review ID and body hash are semantic input to `workOrderDigest`.
- A review body has no delta-review route. The emitter takes it only with `--phase full`, needs no delta decision for it and ignores any delta record for the head. `--review-id` with `--phase commit_only` refuses and names `--phase full`. `--review-id` must match the review node id pattern `PRR_...` that the handoff normalizer also requires, so an ID that the handoff would reject never emits a work order.
- The handoff entry for a review body is `{ reviewId, fixingCommitSha, disposition, validation? }`. Each entry carries exactly one of `threadId` and `reviewId`.
- `verify-fixer-disposition.mjs` re-reads the review live and fails closed when it is gone or when the body hash differs from the pinned hash. For a `tackled` entry it checks `commit_not_contained`, then `reply_missing`. The `not_resolved` step does not apply. On `reply_missing` it posts the marker comment `<!-- dev-loops:review-body-disposition review=<node id> fix=<40-hex commit> -->` once, then re-evaluates.
- The `dev-loops:review-body-disposition` marker stays separate from the Copilot body disposition record (`COPILOT-STATE-BODY-DISPOSITION-RECORD`). The record parser matches only the `dev-loops:copilot-body-disposition` marker, so the review-body marker never clears `copilotBodyFeedbackUnresolved`. After the fix push, the next Copilot review on the new head decides the Copilot gate.
- The no-grant deny of `decideFixerWriteGuard` names the emitter and its three sources.
- Full-SHA rule: the fixer writes the full 40-character commit SHA in every thread reply. `verify-fixer-disposition.mjs` accepts a thread that is already resolved when a trusted reply on it cites the fixing commit in full. A resolved thread whose trusted replies cite only a short SHA refuses with the failed step `resolved_short_sha_reply`. The remedy is `dev-loops-run scripts/github/unresolve-review-thread.mjs --repo <owner/name> --pr <n> --thread-id <thread id>`, then a re-run of the verifier, which replies with the full SHA and resolves again. A `tackled` thread entry must carry the full 40-character `fixingCommitSha`; the handoff normalizer rejects a short one.
- A `deferred` or `rejected` review-body entry completes without evidence beyond the handoff entry, as a `deferred` or `rejected` thread entry does today. This is a deliberate decision: only `tackled` claims a commit, so only `tackled` needs commit evidence.
- The verifier accepts only a handoff whose `reviewId` entries all name the pinned review. If the marker comment it posts is by an author that is not OWNER, MEMBER or COLLABORATOR, it fails with `marker_author_untrusted` (a `--check` run reports an untrusted live marker as `reply_missing`; an untrusted marker from a foreign author does not block the post), naming the author and the remedy. A later run finds that marker live and posts no second one. The trust decision reads the POST response, so a comment list that lags behind the write does not report a trusted author as untrusted. The gate detector evaluates a review-body checkpoint with the same trusted marker read.
- Remaining work of issue 2548 stays open for later slices: the human reviewer re-request through `offer-human-handoff.mjs --fixing-commit`, the fix directive on a work order and the derived Copilot overview body disposition.

## Consequences

A body-only review can reach a fixer through the same pull protocol, with the body pinned by hash. ADR 0106 needs no amendment: its pull protocol, pointer and receipt are unchanged.
