# 0247. Untrusted-comment skip note and issue-comment readers

## Status

Accepted — 2026-11-03 ([issue 3034](https://github.com/mfittko/dev-loops/issues/3034)).

Extends [ADR 0238](./0238-comment-text-from-non-maintainers-never-reaches-an-agent.md). Accepted records remain unchanged.

## Context

ADR 0238 filtered review threads and review bodies at ingestion. Two items stayed open: a visible PR note when comments are skipped (AC4), and the readers of PR conversation comments (AC1, DoD1).

## Decision

Once per head, the gate verdict writer posts a PR note when it skipped unresolved review threads from non-maintainers. The writer runs once per verdict write on the main upsert path, with or without a findings ledger. The note covers review threads. Conversation comments the detector skips are reported in the handoff output (`skippedUntrustedComments`) instead. The note starts with the marker `<!-- dev-loops:untrusted-comments-skipped head=<sha> -->`, then names the count, the sanitized author logins and the short head, states that no agent reads their text, and gives the remedy from ADR 0238. The note never carries comment text. Idempotency reads only comments authored by the authenticated viewer (`findMarkedComment` with the viewer login), so another user who forges the marker cannot suppress the note. A new head posts a new note. A failed post warns on stderr and never fails the verdict.

`detectRecentHumanComments` in `copilot-pr-handoff.mjs` hands the preview of PR conversation comments to the coordinator. It now applies `isTrustedRestComment`. A comment from an untrusted author is dropped: no `bodyPreview`, no pause. Its login is listed in `skippedUntrusted` on the result, which is omitted when empty.

The repository-permission check (write, maintain, admin) is declined for this issue. Association stays the criterion: it is coarse but fails closed, it locks no maintainer out, it needs no extra API call per author, and the issue Non-goals exclude a configuration surface. The trusted set stays OWNER, MEMBER and COLLABORATOR.

The rule paragraph of `GATE-REVIEW-COMMENT-TRUST` is amended in a follow-up, because other open pull requests hold the contract file.

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
| `detect-checkpoint-evidence` gate-verdict summaries | Open. Gate-formatted comments and reviews from any account reach summarizeGateReviewComments and the marker summarizers, so a forged verdict can put findingsSummary and nextAction text in front of the coordinator. The fix is a trusted-or-viewer filter at ingestion (association check, or the authenticated viewer login for a gate that posts under a bot identity). It is deferred to the last slice of issue 3034 because about 77 existing fixtures in six test files carry no author or association and need migrating, which exceeds this slice's size budget. |

## Consequences

A maintainer sees that comments were skipped and how to clear them. The coordinator never reads a preview of a non-maintainer conversation comment.
