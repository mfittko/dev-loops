# 0168. A low/nit draft_gate round converges after one fixer pass and a clean delta review

## Status

Accepted — 2026-10-20 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462))

Amends `GATE-EXEC-REGATE-MANDATORY`, `GATE-COMMENT-DRAFT-REQUIREMENTS` and `PRE-PUSH-DELTA-NOT-GATE-EVIDENCE` for this case only. Amends [0094](./0094-pre-push-reviewer-delta-mode.md) and [0089](./0089-judge-act-list-drives-review-verdict.md) for this case only: a `clean` `draft_gate` verdict may stand over an all-low/nit act list. It narrows the statement of [0131](./0131-pre-push-delta-thread-route-and-decision-record.md) that no gate verdict comment reads a delta result: for this case the comment records the digest of the clean delta result. The records that introduced those rules stay unedited.

## Context

`GATE-EXEC-REGATE-MANDATORY` requires a fresh full `draft_gate` round on every new head. A round whose judge act items are all low or nit still forces that second full round after one small fix. The mandatory `pre_approval_gate` reviews the final head in full anyway. `PRE-PUSH-DELTA-NOT-GATE-EVIDENCE` keeps the pre-push delta result out of every gate artifact.

## Decision

- A `draft_gate` round at head A whose open act items are all `low` or `nit` (a non-empty list) converges after one `commit_only` fixer pass and a fresh `locally_clear` delta review of the fixer commit: one pre-push delta sequence from A, bound by the delta result baseline A and `candidateHead` = the fixer commit. A `medium`, `high`, `question` or unknown item, or a mixed list, keeps the full round. There is no round count and no cap.
- The `draft_gate` comment at A is updated to `clean` with a `**Converged:** fixer <sha> delta sha256:<digest>` line. The digest is the sha256 of the clean delta result. `composeConvergedDraftGate` fails closed on every malformed, stale, non-eligible or new-finding input. `upsert-checkpoint-verdict.mjs` permits `clean` over act items only through it, requires `--findings-ledger` and takes the act items from the union of the ledger at A and the `--findings-json` act items (it refuses without the ledger, and a missing or unreadable ledger refuses naming the path and error), refuses a PR head other than the fixer commit, and refuses a comment at A that is already clean or converged.
- `summarizeGateReviewCommentMarkers` returns that comment as the `draft_gate` marker of the fixer commit's head. Gate coordination then returns `mark_ready_for_review`, then `pre_approval_gate`.
- `GATE-EXEC-REGATE-MANDATORY` names this exception. `PRE-PUSH-DELTA-NOT-GATE-EVIDENCE` names the delta result as the proof behind the marker for this case.
- The `pre_approval_gate` stays a full review of the final head. `merge-pr.mjs` is unchanged. The marker is not a merge evidence kind.

## Consequences

An all-low/nit `draft_gate` round saves one full fan-out. The delta result is still not a gate verdict: only its digest is recorded, and the final head gets a full review.
