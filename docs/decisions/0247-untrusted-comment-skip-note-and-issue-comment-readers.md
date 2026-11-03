# 0247. Untrusted-comment skip note and issue-comment readers

## Status

Accepted — 2026-11-03 ([issue 3034](https://github.com/mfittko/dev-loops/issues/3034)).

Extends [ADR 0238](./0238-comment-text-from-non-maintainers-never-reaches-an-agent.md). Accepted records remain unchanged.

## Context

ADR 0238 filtered review threads and review bodies at ingestion. Two items stayed open: a visible PR note when comments are skipped (AC4), and the readers of PR conversation comments (AC1, DoD1).

## Decision

Once per head, the gate verdict writer posts a PR note when it skipped unresolved review threads from non-maintainers. The writer runs once per verdict write on the main upsert path, with or without a findings ledger. The note covers review threads. Conversation comments the detector skips are reported in the handoff output (`skippedUntrustedComments`) instead, with a conversation remedy (a maintainer restates the request in their own comment), since a conversation comment has no thread to reply to or resolve. The note starts with the marker `<!-- dev-loops:untrusted-comments-skipped head=<sha> -->`, then names the count, the sanitized author logins and the short head, states that no agent reads their text, and gives the remedy from ADR 0238. The note never carries comment text. Idempotency reads only comments authored by the authenticated viewer (`findMarkedComment` with the viewer login), so another user who forges the marker cannot suppress the note. A new head posts a new note. A failed post warns on stderr and never fails the verdict.

`detectRecentHumanComments` in `copilot-pr-handoff.mjs` hands the preview of PR conversation comments to the coordinator. It now applies `isTrustedRestComment`. A comment from an untrusted author is dropped: no `bodyPreview`, no pause. Its login is listed in `skippedUntrusted` on the result, which is omitted when empty.

The repository-permission check (write, maintain, admin) is declined for this issue. Association stays the criterion: it is coarse but fails closed, it locks no maintainer out, it needs no extra API call per author, and the issue Non-goals exclude a configuration surface. The trusted set stays OWNER, MEMBER and COLLABORATOR.

The once-per-head untrusted-comments-skipped note is a third exception to `GATE-COMMENT-SINGLE-SURFACE`, next to the opt-in findings comment and the deferred-summary comment.

The rule paragraph of `GATE-REVIEW-COMMENT-TRUST` in `skills/docs/gate-review-sub-loop-contract.md`, the `GATE-COMMENT-SINGLE-SURFACE` paragraph in `skills/docs/gate-review-comment-contract.md` and the one-surface wording of `GATE-EXEC-FINDING-THREADS` (sub-loop contract) are amended in slice 3 of issue 3034, because other open pull requests held the contract files. Slice 2 left them unchanged.

## Audit of comment-text readers

| Site | Filter status |
| --- | --- |
| `list-review-threads`, `capture-review-threads`, `parseReviewThreads` | Filtered at ingestion (ADR 0238). |
| `emit-fixer-work-order` threads and review-body sources | Filtered (ADR 0233, ADR 0238). |
| `_copilot-body-disposition`, `verify-fixer-disposition` | Filtered (`isTrustedDispositionAuthor`). |
| `probe-copilot-review` | Filtered (slice 1b). |
| `copilot-pr-handoff` `detectRecentHumanComments` | Filtered here. |
| `request-copilot-review` `checkForCopilotComments` | No filter needed. It reads bodies only to detect summon violations and emits comment ids, never body text. |
| `merge-pr`, `_policy-change-approval`, `_carried-verdict`, `post-gate-findings` | No filter needed. They match gate markers and approvals by viewer-scoped or owner-scoped author, or parse a machine record, and emit no body text. |
| `detect-refinement-grill-state --comments-file` | No filter needed. It matches a fixed provenance marker and emits booleans and a bypass login, never body text. |
| `detect-checkpoint-evidence` gate-verdict summaries, marker summarizers, approval facts, carried heads | Filtered in slice 3 ([ADR 0248](./0248-detector-evidence-trust-filter.md)): trusted-or-viewer filter at ingestion. Originally deferred because about 77 fixtures in six test files carried no author or association. |
| `fetchGateEvidenceComments` (`gh pr ready` guard), `fetchListedFingerprints`, `resolveGateRound` inputs in `close-gate-findings` and `upsert-checkpoint-verdict` | Filtered in slice 3 (ADR 0248). |
| Review agent prose (`agents/review.agent.md` delta-review step) | Closed in slice 3: it reads through `detect-checkpoint-evidence`, not raw `gh`; a contract test bans raw readers in `skills/` and `agents/`. |
| `scripts/release/verify-release-approval.mjs` | No filter needed. It accepts only comments whose author login equals the repo owner (or the `--operator` login), matched case-insensitively. It emits a refusal message and the operator login, never comment text, so no body reaches an agent. |

## Consequences

A maintainer sees that comments were skipped and how to clear them. The coordinator never reads a preview of a non-maintainer conversation comment.
