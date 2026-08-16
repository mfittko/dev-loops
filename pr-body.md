## Summary

Closes #1731. Scrubs the offending issue reference from the PR-1728 Copilot review comment and adds a durable, fail-closed **guard** so no generated gate/review/verdict comment body can ever emit a raw issue/PR id again.

## Change

### Scrub
- Removed the single raw issue reference from the Copilot PR review overview comment on the linked PR (edited in place via the review-body endpoint). Audited all of that PR's gate/review comments (draft_gate, pre_approval_gate, inline finding comments, dispositions) — the gate verdicts carried no issue/PR ids (head SHAs only), so the Copilot overview was the only offending comment. After the edit, `grep` and an id scan confirm no `#digits` remain in any of that PR's comment bodies.

### Guard (the "won't happen again" half — operator directive)
- New core helper `comment-id-guard.mjs` (`extractIssuePrIds` / `guardCommentBodyNoIssuePrIds`), exported as `@dev-loops/core/github/comment-id-guard`.
- **Fail-closed**: refuses (throws) a body containing a raw `#<digits>` token unless that id is explicitly allowlisted (`allowedRefs`) as a deliberate cross-reference. No silent stripping — removal forces the caller to make a cross-ref deliberate or reword generically.
- Wired at the low-level comment/review write helpers used by all current **and future** gate/review/verdict comment generation:
  - gate verdict body — `upsert-checkpoint-verdict.mjs` (single `desiredBody` choke point, covers review + legacy issue-comment surfaces) + `createGateReview`/`updateGateReview` in `_gate-finding-surface.mjs` (verdict body + each inline finding comment)
  - gate findings comment — `post-gate-findings.mjs` `createComment`/`updateComment`
  - review-thread replies — `_review-thread-mutations.mjs` `replyAndMaybeResolve`
  - generic issue comments — core `commentIssue` in `issue-ops.mjs` (used by `comment-issue.mjs`)
- Scrub a leaked id the guard immediately caught in production code: the low-severity deferral reply body in `close-gate-findings.mjs` emitted `#1585`.

### Test
- `packages/core/test/comment-id-guard.test.mjs`: asserts a generated comment body contains no issue/PR id, that the guard refuses raw ids, allows explicitly-allowlisted deliberate cross-refs, and passes a representative rendered gate-verdict body through clean.

## Acceptance criteria
- [x] The offending comment on PR 1728 has its issue/PR id removed.
- [x] No other comment in scope contains an issue/PR id (audited; only the Copilot overview had one).
- [x] Guard implemented in the comment writers: generated comment bodies cannot emit issue/PR ids (fail-closed), with a test proving it.
- [x] The guard is wired so it applies to all current and future gate/review/verdict comment generation.

## Definition of done
- [x] Scrub done on the live comment; verified post-edit (no `#digits` remain).
- [x] Guard lives in core and is enforced at the write helpers, so it cannot be bypassed by a future writer that routes through them.
- [x] Deliberate cross-refs require an explicit allowlist (no raw interpolation).
- [x] Regression test asserting no issue/PR id in a generated comment body.
- [x] `npm run verify`, `assets:check`, `schema:check` green.

## Validation command
Run `npm run verify` locally or rely on the `verify` CI suite. The guard is unit-tested by `packages/core/test/comment-id-guard.test.mjs`; the affected writer tests (`upsert-checkpoint-verdict`, `post-gate-findings`, `gate-finding-surface`, `close-gate-findings`, `reply-resolve-review-thread`, `comment-issue`, `edit-comment`) pass under `npm run test:core` / `npm run test:scripts`.

## Non-goals
- No change to issue/PR linking in PR **descriptions** (the `Closes #1731` closing keyword is the sanctioned deliberate linking mechanism and is unaffected).
- No stripping of ids from already-posted external/Copilot comments (one-off scrubs remain manual).
