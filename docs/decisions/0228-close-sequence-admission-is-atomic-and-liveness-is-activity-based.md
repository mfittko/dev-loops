# 0228. Close-sequence admission is atomic and the fixer liveness rule is activity-based

## Status

Accepted — 2026-11-02 ([issue 2999](https://github.com/mfittko/dev-loops/issues/2999)).

Amends [0219](0219-sanctioned-close-of-an-abandoned-gate-fix-sequence.md) in three places: the command spelling (decision 8), the grace period, which is the runner TTL `resolveStaleRunnerMaxAgeMs` (decision 7), and the liveness rule, which is activity-based (decision 6). Accepted records remain unchanged.

## Context

`close-gate-sequence` checks the pull receipt, writes the closure record and removes the marker. `pullWorkOrder` checks the closure record and writes the receipt. Each side checks and then writes, so a pull can land after a closure record exists and a close can land after a pull. A re-emit can also replace the marker between the close check and the marker removal. The 30 minute pulled-and-running rule measured pull age, so a fixer that was still working past 30 minutes read as abandoned. The grace was a literal that ADR 0219 called the runner-lock TTL, which an operator can override.

## Decision

1. `withSequenceLock` in `packages/core/src/loop/fix-push-authority.mjs` takes a `mkdir` lock per baseline head at `gate-delta/<head>.sequence-lock`, in sorted order, and releases in reverse order. A lock older than 60 seconds is stolen. A lock held past a 10 second wait fails with `SEQUENCE_LOCK_BUSY`. This is a ponytail ceiling: one directory lock per head, stale-steal by age. The lock dir holds an owner token, release removes the lock only while the token matches, and a stale lock is stolen by rename to a unique name then removal. Remaining ceiling: a holder that stalls past 60 seconds and then runs on can still overlap a stealer.
2. The close runs its final recheck, the record write and the marker removal under the lock. The marker removal compares the marker identity and mtime again under the lock and leaves a replaced marker in place. A busy lock refuses `sequence_live` with the remedy to rerun.
3. The fixer emission writes the marker under the same lock, so a replacement cannot interleave with a close.
4. `pullWorkOrder` calls an optional `adapter.admit(unit, writeReceipt)`. The fixer adapter takes the lock on the closure heads, rechecks the closure record, refuses `stale_dispatch` when it exists, and otherwise writes the receipt. A receipt never lands after a closure record, and a close never lands after a receipt. A busy lock refuses `sequence_lock_busy`, retryable.
5. The closure key stays the baseline head plus the execution. A new execution emitted on the same head after a close stays pullable.
6. A pulled fixer reads as running unless it handed back or its last activity is older than the grace. Last activity is the later of `pulledAt` and the mtime of the fixer branch reflog (`<git common dir>/logs/refs/heads/<branch>`). A fixer that never commits shows only its pull (named residual). `FIXER_NEVER_PULLED` stays on the marker mtime, the only activity of an unpulled dispatch. The runner claim `updatedAt` is not used, because the closing coordinator heartbeats it.
7. The grace is the runner-lock TTL itself (`resolveStaleRunnerMaxAgeMs`, including the `DEVLOOPS_STALE_RUNNER_MAX_AGE_MS` override). The literal is removed.
8. The recovery command has one runnable spelling: `dev-loops-run cli/index.mjs gate close-sequence --head <baseline sha> --repo <owner/name> --pr <number>`. Both pre-push refusal texts name it.
9. Residual: a fork that shares objects with the repository can satisfy the legacy-marker baseline check.

## Consequences

A concurrent close and pull end with exactly one winner. A busy lock costs a rerun. A long-running fixer that keeps committing to its branch is not closed; one that never commits is closed after the grace from its pull. A crashed holder blocks the lock for at most the stale age.
