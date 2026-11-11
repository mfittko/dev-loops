# 0264. Resolve linked issue startup through the existing PR route

## Status

Accepted — 2026-11-11 (https://github.com/mfittko/dev-loops/issues/3144#issuecomment-6796476929)

## Context

[Issue 3144](https://github.com/mfittko/dev-loops/issues/3144) records PR startup losing its closing issue and assuming Copilot ownership, while issue startup derives different ownership and omits draft continuation. The approved slice keeps the existing target schema and lightweight authority checks.

## Decision

Both startup entrypoints reuse the PR route when the issue already has an open linked PR. Derive ownership from PR authorship. A shared selector reads GitHub `closingIssuesReferences`: one issue binds the coordinator target, several refuse with the candidate list, and zero retains the existing validated lightweight fallback. Envelope construction rechecks live linkage before emission. Authorized human draft continuation applies to the external follow-up strategy too.

Keep the lifecycle umbrella resolver's multi-issue and body-reference semantics separate. Read-only review selectors retain their ownership exemption. Preserve assignment guards and the Copilot-assigned draft stop.

Reject a new target model or parallel startup implementations: existing target fields and one PR route cover this slice. Child/parent targets and new cross-repository, closed/merged and body-disagreement semantics remain deferred.

## Consequences

Issue and PR recovery select the same artifact, ownership and strategy. Multiple closing issues need an explicit single coordinator unit. Existing lifecycle and PR-body validation remain authoritative; this decision grants no ready or merge authority.
