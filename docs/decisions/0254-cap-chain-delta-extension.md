# 0254. A locally_clear pre-push delta extends the cap-round chain over code commits

## Status

Accepted, 2026-11-05 ([issue 3105](https://github.com/mfittko/dev-loops/issues/3105), [issue 3049](https://github.com/mfittko/dev-loops/issues/3049)).

Amends [ADR 0224](./0224-cap-round-proof-for-adr-waiver-and-docs-tests-chain-extension.md) and [ADR 0250](./0250-clean-cap-round-chain-extension.md). Every other decision of those records stays in force, and the records stay unedited.

## Context

ADR 0224 and ADR 0250 let `gate extend-cap-round-chain` extend the sealed cap-round clearing chain over docs and tests commits only. A code commit after the cap-round head refuses `logic_commit_in_range`, and coordination routes the PR to `report_blocked` with no runnable exit (issue 3049). Issue 3105 makes the cap soft: a `locally_clear` pre-push delta review checks the fix and the chain then extends over every later commit that such a review covers.

The pre-push delta tool (`check-pre-push-delta.mjs --result`) seals one record per baseline at `gate-delta/<baseline>.json`, with `candidateHead`, `outcome` and `nextStep`. The chain extension record for a chain end E lives at the same path, so one file cannot hold two records for E.

## Decision

1. When commits after the start of the logic range touch logic files, `extend-cap-round-chain` accepts them if the sealed clearing record bound to the start of the logic range has `candidateHead` equal to the PR head and `outcome` `locally_clear`. The start of the logic range is the cap-round head for a clean cap round, or the candidate head of an already-extended cap-head record (the end of the extended chain), otherwise the chain end. The record's `reviewBaselineHead` is that start, so the review covers exactly start..head. Under the rule, a later link in the chain is not a covering record. The tool re-seals that same record with `extension: "delta_covered"` added and every other field kept, then verifies `resolveCapRoundFixed` reaches the head. A failed proof restores the original record and seal byte for byte, only while the record is still the one this run wrote; a record another writer replaced stays in place. This amends the "never overwrites" clause of ADR 0250 for this one case: the delta tool's own record is re-sealed, never replaced by a different record.
2. A code range with no covering record refuses `logic_commit_in_range`. A sealed clearing record at the start of the logic range that covers another range, or has an outcome other than `locally_clear`, refuses `delta_range_mismatch`. Both refusals name the runnable remedy: run `check-pre-push-delta.mjs --result` for the start of the logic range (the cap-round head for a clean cap round, or the candidate head of an already-extended cap-head record (the end of the extended chain), otherwise the chain end) until `locally_clear`, then rerun the command; a clean cap round has no act list, so its remedy is the thread-route delta (`--threads-file`), which needs at least one unresolved review thread; with none, the remedy is the replacement-PR restart. Coordination routes three failures to this command, so the delta or the replacement-PR restart breaks the cycle. A sealed record that already carries an extension for the head refuses `proof_not_reached` and writes nothing. A delta record that changed on disk after validation refuses `record_changed`: nothing is written, rerun the command.
3. Docs and tests commits keep the ADR 0224 and ADR 0250 path unchanged: the extension record is created exclusively and a plain record is never overwritten.
4. Coordination routes the cap-round failures `no_clearing_record`, `items_do_not_cover` and `chain_does_not_reach_head` to `report_blocked` with `agentRemedy` `dev-loops gate extend-cap-round-chain --repo <owner/name> --pr <n>` and refusal texts that name the code-commit remedy. This removes those dead ends under the no-dead-end invariant of issue 3105.
5. The rule `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND` in `skills/docs/gate-review-sub-loop-contract.md` records the behavior.

## Consequences

A code commit past the cap-round head converges through a fixer pass, a `locally_clear` delta and one command. The delta tool needs at least one act item and a fix commit, so a code range with no act item has no producer of a covering record. Each remaining condition (`baseline_orphaned`, `unsealed_record`, `cap_round_unresolved`) stays an untyped known gap until a later slice of issue 3105.
