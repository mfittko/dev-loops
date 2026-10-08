# 0132. merge-pr enforces the ADR tripwire and re-issues a stale standing waiver

## Status

Accepted — 2026-10-08 ([issue 2682](https://github.com/mfittko/dev-loops/issues/2682))

## Context

Amends [0119](./0119-standing-authorization-for-adr-tripwire-waivers.md): the writer's eligibility check accepts a second gate verdict, and a second caller runs the writer at merge time. The rest of 0119 stands. Record 0119 stays unedited.

A PR merged as a drain merge while the ADR tripwire blocked at its head. Its standing-authorization waiver line was pinned to an earlier head, and `merge-pr` had no tripwire precondition. After the ready flip the writer could not re-issue the line either. Post-ready pushes get only a `pre_approval_gate` round, and 0119 requires a clean current-head `draft_gate`.

## Decision

- `merge-pr.mjs` gains an `adr_tripwire` precondition on every merge class. It fetches the PR head and evaluates the tripwire at `origin/<baseRefName>`..`<headRefOid>` against the current PR body. A block, or any fetch or evaluator error, refuses the merge.
- When the block comes only from a standing-authorization waiver line pinned to an older head, `merge-pr` calls `waiveAdrTripwire` in-process, re-reads the PR body and re-evaluates. Every 0119 eligibility check still runs in the writer. A writer refusal refuses the merge and quotes the writer's typed reason.
- `waive-adr-tripwire` accepts a clean current-head `pre_approval_gate` verdict as an alternative to a clean current-head `draft_gate` verdict. The recorded `specDigest` of that gate's ledger must equal the linked issue's current digest.

The trigger set, the 0119 exclusions and the standing authorization record are unchanged.

Rejected: moving the tripwire into CI (a separate decision). Rejected: a merge-time bypass flag (a fail-open surface).

## Consequences

A stale waiver can no longer reach a merge. A post-ready push that changes only a covered contract doc regains a valid waiver at merge without an operator prompt. An uncovered trigger stops the merge with the writer's reason.
