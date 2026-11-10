# 0263. Runtime pins invalidate reviews without counting as source

## Status

Accepted, 2026-11-10, by the owner's [refinement decision](https://github.com/mfittko/dev-loops/issues/3178#issuecomment-6779537706).

## Context

[Issue 3178](https://github.com/mfittko/dev-loops/issues/3178) reports that a runtime-pin bump blocks size measurement as entirely unclassified source, despite containing no code. Review invalidation still needs to treat ordinary runtime pins as unknown, as established in [issue 2732](https://github.com/mfittko/dev-loops/issues/2732).

## Decision

Keep classifier precedence and carry-forward unchanged. Share a fixed five-basename runtime-pin set with size accounting, which excludes matching normalized basenames from source counters and logic LOC. Preserve the independent configured-tier guard, unknown-source ratio threshold and unwaivable failure. Its diagnostic names up to five positive-line unknown contributors plus the omitted count. The owning rule is `SIZE-RUNTIME-PIN-ACCOUNTING` in the [pre-push review contract](../../skills/docs/pre-pr-review-contract.md).

## Consequences

Runtime maintenance can pass size measurement without carrying stale clean verdicts. Pins cannot dilute arbitrary unknown source. No new classification category, configuration knob or waiver is introduced; existing directory and custom classification rules retain precedence.
