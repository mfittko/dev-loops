# 0186. Consume a carried gate verdict only after recomputing it from GitHub-visible state

## Status

Proposed

Amends [0156](./0156-carry-gate-verdict-across-base-only-merge.md).

## Context

ADR 0156 shipped the classifier `computeBaseMergeCarry` and the evidence record for a base-only merge. It left consumption to a follow-up slice. Until gate evidence and `merge-pr` read a carry, a base-only merge still dispatches a full gate round on the new head ([issue 2752](https://github.com/mfittko/dev-loops/issues/2752), slice 2, PR 2838). A consumer that trusts a carry without a durable record and a fresh recomputation would accept stale or forged evidence. Record 0156 stays unedited.

## Decision

Gate evidence consumes a carried verdict under these rules:

- `detect-checkpoint-evidence` presents the latest cross-head clean marker at the current head, with the field `carriedFrom` set to the origin head, only when two conditions hold. First, `computeBaseMergeCarry` for origin head to current head returns `carry_verdict`. Second, the evidence passes `validateBaseMergeCarryEvidence` bound to both heads. The check reads the posted verdict and git facts from a full-history checkout. It reads no local `tmp/` record.
- The same recomputation runs in gate coordination, `merge-pr`, the ready-transition guards and the server-side `gate-evidence` workflow, which also triggers on `synchronize`. One helper resolves the base ref (gh, then the REST fallback) for every reader.
- The durable record is a hidden-marker PR comment, `dev-loops:carried-heads:v1`, that lists per gate the origin head and each carried head with its classification decision and a sha256 digest of the classifier evidence. Gate coordination prunes the record to the current origin head and at most 20 entries, so it stays below the GitHub comment size limit. It holds no credential. Gate coordination upserts the entry when it carries. Every other reader carries only when the entry for the current head exists and equals the recomputed evidence. A missing or differing entry falls back to a full re-gate. The PR body is not edited.
- Fan-out ledger evidence stays keyed at the origin head. The carry does not rewrite ledger entries.
- CI green at the current head stays a merge precondition.

Rejected: a local carried-heads record under `tmp/`. A fresh CI runner never has it, so a server-side check could not verify a carry from it. The GitHub-visible comment replaces it.

## Consequences

A base-only merge that keeps the PR blobs unchanged dispatches no gate round. A carry with a PR-own change or malformed evidence fails recomputation and falls back to a full re-gate. Fixer-disposition completion on a carried head is out of this record and moves to issue 2787; a carried head keeps the advisory unverified_active_fixer behavior (ADR 0155).
