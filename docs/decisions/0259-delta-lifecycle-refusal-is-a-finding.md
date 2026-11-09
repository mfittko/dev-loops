# 0259. A delta lifecycle refusal is a finding in the sealed record

## Status

Accepted, 2026-11-09 ([issue 2447](https://github.com/mfittko/dev-loops/issues/2447)).

Amends [ADR 0094](./0094-pre-push-reviewer-delta-mode.md) on the refusal path of the `--result` run. Every other decision of that record stays in force, and the record stays unedited.

## Context

In the pre-push delta `--result` run, a lifecycle or docs-validator refusal exits 2. An exit 2 is an infrastructure signal, so the loop leaves the fixer route and an operator has to intervene, although the cause is open fixer work such as a stale doc surface or an unresolved residue task. Issue 2447 records the stalls this caused.

## Decision

1. In the `--result` run, a lifecycle or docs-validator refusal becomes a `lifecycle: true` medium finding in the sealed record. The record seals `needs_fix` and the loop stays in the fixer route.
2. Infrastructure errors and a dirty tree (a tracked edit or an untracked non-ignored file) keep exit 2.
3. A same-candidate `commit_only` re-emission lists the open tasks and requires a new commit on top of HEAD before the next emission.
4. A hand-back at the reviewed candidate with open lifecycle or residue work is refused.

## Consequences

A refusal that a fixer can clear no longer stops the loop. The sealed record names each open task, so the next fixer pass has a concrete list. Exit 2 keeps its meaning of an infrastructure fault. The contract paragraphs in `skills/docs/pr-lifecycle-contract.md` and `skills/docs/pre-pr-review-contract.md` state this route and link here. The reviewer-only route stays under ADR 0255.
