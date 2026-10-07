# 0128. Finding comments reference no local artifacts

## Status

Accepted — 2026-10-07 ([PR 2691](https://github.com/mfittko/dev-loops/pull/2691))

## Context

Related: [0008](./0008-fail-closed-gate-comment-evidence.md) and [0075](./0075-fold-sub-floor-findings-out-of-inline-threads.md). This record amends neither.

Finding comments ended with `Full text: ledger entry <fp>`. The ledger is local, so readers on GitHub cannot open it. See [issue 2629](https://github.com/mfittko/dev-loops/issues/2629).

## Decision

A finding comment posted to GitHub never references a local artifact such as a ledger entry or a `tmp` path.

- Extra detail, including the full text of any cut field, goes into one collapsed `<details>` block.
- Code-like content renders in a fence that is longer than any backtick run inside it. Every fenced line is indented, so content cannot forge a line-anchored marker.
- The `**severity** · angle` header stays, because parsers read it.

Rejected alternative: keep the ledger pointer (readers cannot follow it).

## Consequences

A reader gets the full finding from the comment alone. Parsers of the header and of line-anchored markers see unchanged input.
