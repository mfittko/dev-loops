# 0165. Consume a carried gate verdict only from a recorded, revalidated carry

## Status

Proposed

Amends [0156](./0156-carry-gate-verdict-across-base-only-merge.md).

## Context

ADR 0156 shipped the classifier `computeBaseMergeCarry` and the evidence record for a base-only merge. It left consumption to a follow-up slice. Until gate evidence and `merge-pr` read a carry, a base-only merge still dispatches a full gate round on the new head ([issue 2752](https://github.com/mfittko/dev-loops/issues/2752), slice 2, PR 2838). A consumer that trusts a carry without a durable record and a fresh recomputation would accept stale or forged evidence. Record 0156 stays unedited.

## Decision

Gate evidence consumes a carried verdict under these rules:

- `detect-checkpoint-evidence` presents the latest cross-head clean marker at the current head, with the field `carriedFrom` set to the origin head, only when two conditions hold. First, `computeBaseMergeCarry` for origin head to current head returns `carry_verdict`. Second, the durable carried-heads record has an entry for the current head whose evidence passes `validateBaseMergeCarryEvidence` and equals the recomputed evidence. The record lives at `tmp/carried-heads/<repo>/pr-N/<gate>-<originHead>.carried-heads.json`, anchored at the main checkout.
- The coordination path records the carried-heads entry. `merge-pr` reads the record and never writes it. `merge-pr` therefore never accepts an unrecorded carry.
- Fan-out ledger evidence stays keyed at the origin head. The carry does not rewrite ledger entries.
- CI green at the current head stays a merge precondition.

Rejected: letting `merge-pr` record the carry itself. The merge step would then both create and accept its own evidence, so a carry that the coordination path never validated could pass the merge gate.

## Consequences

A base-only merge that keeps the PR blobs unchanged dispatches no gate round. A stale, forged or unrecorded carry fails validation or recomputation and falls back to a full re-gate. The coordination path owns the carried-heads record, so a missing record costs one gate round and never a false pass. Fixer-disposition completion on a carried head is out of this record and moves to issue 2787; a carried head keeps the advisory unverified_active_fixer behavior (ADR 0155).
