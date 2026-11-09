# 0261. A sealed delta record is taken over or protected, never deleted

## Status

Accepted, 2026-11-09 ([issue 3139](https://github.com/mfittko/dev-loops/issues/3139)).

Amends decisions 6, 7 and 9 of [ADR 0255](./0255-code-range-delta-without-fixer-plan.md). Every other decision of that record stays in force, and the record stays unedited.

## Context

PR 3138 stopped at the "Remaining" row of ADR 0255 that named `rm -f <record> <record>.seal` for a sealed non-clearing record with another ref set or an off-history candidate. The operator deleted a round 4 record. That destroyed valid clearing evidence and changed nothing.

## Decision

- Rule: the reviewer-only run takes over a sealed non-clearing record (`needs_fix`) at the baseline whatever its ref set or candidate, because such a record is never clearing evidence. The takeover continues the prior record's invocation count, so the bound of 3 holds, and a record at invocation 3 refuses `bounded_out`, `restart_on_replacement_pr`.
- A sealed `locally_clear` record of another act set stays protected. Its refusal names the chain-end command when its refs equal the derived refs and its candidate is on the head's history, and otherwise the replacement-PR restart. A record that carries an extension stays protected as before.
- No refusal for a sealed record names `rm` or any other record deletion.
- An unsealed record is never taken over, whatever its content: the content of an unsealed file, its invocation count included, is never evidence. It refuses `unsealed_record` with the remedy `rm -f <record> <record>.seal` and a rerun, which restarts the invocation count. This replaces the take-over of a passing unsealed record in decision 7.
- The "Remaining" table of ADR 0255 changes accordingly: the sealed non-clearing row is closed by the take-over, a sealed `locally_clear` record of another act set with another ref set names the replacement-PR restart, and every `unsealed_record` names the `rm -f` remedy.

## Consequences

A sealed record is never deleted by a remedy, so clearing evidence survives a handoff. A crash that leaves an unsealed pair costs one invocation restart. The gate-review contract rule `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND` states the behavior, and `test/loop/check-pre-push-delta.test.mjs` and `test/loop/cap-round-no-dead-end.test.mjs` prove it.
