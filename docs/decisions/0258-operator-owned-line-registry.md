# 0258. One registry owns the operator-owned comment lines

## Status

Accepted, 2026-11-08 ([issue 2410](https://github.com/mfittko/dev-loops/issues/2410)).

Amends [0130](0130-comment-wrappers-refuse-operator-owned-lines.md) on the line set, the refusal point and one override. The rest of 0130 stands. Record 0130 stays unedited.

## Context

ADR 0130 named two operator-owned lines and put the refusal in `comment-issue.mjs` and `edit-comment.mjs`. Three gaps remain. No writer refuses `approve release v<version>`, so an agent-written phrase passes the only tool check before an npm `latest` publish. No writer refuses the Copilot `operator` disposition marker, which the merge path and the below-cap convergence rule still read. The other sanctioned writers that call `guardCommentBodyNoIssuePrIds` do not refuse operator-owned lines. The operator and the agents share one GitHub credential, so only the write side can hold the boundary.

## Decision

1. `packages/core/src/github/operator-owned-lines.mjs` is the registry. It lists `approve-merge`, `approve-release`, `adr-tripwire-allow` and `copilot-body-disposition-operator`. `findOperatorOwnedLineRefusal` returns the refusal of the first matching entry. Adding a line is one new entry.
2. `guardCommentBodyNoIssuePrIds` calls the registry, so every sanctioned comment writer that calls the guard refuses an operator-owned line. `--allowed-refs` applies to the issue-id check only and never clears a refusal. The refusal exits 1, makes no GitHub call, names `OPERATOR-OWNED-LINE` and the entry, and says the human posts the line.
3. Each entry has a `standingAuthorization` value. Only `copilot-body-disposition-operator` is `true`. `comment-issue.mjs` and `edit-comment.mjs` accept `--standing-authorization`, an unverified assertion of a recorded standing operator authorization, as `merge-pr.mjs` does. The flag clears only that entry. A per-instance operator ask is not a standing authorization.
4. The marker parser moves to `packages/core/src/github/copilot-body-disposition-marker.mjs`. The reader and the registry import it, so no second marker regex exists.

5. Gate surfaces wrap instead of refusing (operator decision, 2026-11-08). The writers behind the verdict review, the inline finding comments, the findings comment, the deferred summary and the close and reject replies (`upsert-checkpoint-verdict.mjs`, `_gate-finding-surface.mjs`, `post-gate-findings.mjs`, `close-gate-findings.mjs`) render reviewer, judge and Copilot free text. A reviewer who quotes an operator-owned phrase would otherwise make the guard refuse the whole round. These writers call `wrapOperatorOwnedPhrases` from `@dev-loops/core` through their shared `escapeProse` and `sanitizeInline` helpers and the free-text input seams. It wraps the matching text of each registry entry in a code span, and a line-start `approve merge` no longer opens its line. The readers strip code spans, so a wrapped phrase asserts nothing. The guard stays strict. `comment-issue.mjs`, `edit-comment.mjs` and every non-gate writer keep the refusal with no override flag. The no-core `post-gate-verdict-fallback.mjs` cannot import core and has no wrap, so it keeps the refusal through a local twin of the registry. A parity test over shared fixtures fails on drift.

ADR 0130 rejected an override flag for the whole set. That rejection stays for `approve merge`, `approve release` and `adr-tripwire:allow`. The single flag exception covers the Copilot `operator` form (operator decision, 2026-10-09).

## Consequences

Every guarded writer refuses the four lines, with one registry to extend, except that the gate surface writers wrap a bare phrase in reviewer free text. The guard stops an instruction-following agent. An agent that calls the GitHub API directly with the shared token is not stopped, and a separate agent identity is a non-goal. On Pi the wrapper refusal holds. The raw comment-write deny belongs to a later record. The readers stay unchanged. The human posting path and the grill `bypass:` provenance line stay open operator decisions.
