# 0203. A findings-log that fails integrity is quarantined, never hand-edited

## Status

Accepted — 2026-10-28 ([PR 2970](https://github.com/mfittko/dev-loops/pull/2970))

## Context

Issue [2969](https://github.com/mfittko/dev-loops/issues/2969) reported a hand-edited fan-in ledger at PR 2838. The edit broke carry-forward integrity of the prior-head gate findings-log, and every later gate round failed closed.

The fail-closed refusal is correct. A log that fails integrity must not feed carry-forward. The contract offered no sanctioned exit, so operators edited the ledger by hand, which is the behavior the integrity check exists to prevent.

The change adds a rule to [Gate review sub-loop contract](../../skills/docs/gate-review-sub-loop-contract.md), which trips the ADR tripwire.

## Decision

- `scripts/github/quarantine-gate-findings-log.mjs` re-runs the carry-forward integrity check on the prior-head log. On failure it moves the log and its fan-in ledger into an audit directory (never deletes) and records the reason and the exact failure.
- The command refuses with `quarantine_refused_log_valid` when the log passes integrity. Valid evidence is never discarded.
- Rounds after a quarantine ignore findings logs written at or before the latest quarantinedAt and dispatch every angle fresh.
- The command is registered as `gate-findings-log-quarantine` in the sanctioned-commands map. The rule ID is `GATE-EXEC-FINDINGS-LOG-QUARANTINE`.

## Consequences

A broken log has one sanctioned recovery path, and the evidence stays auditable. The next round re-reviews every angle, which costs more review work and never less. Hand-editing a ledger remains unsanctioned.
