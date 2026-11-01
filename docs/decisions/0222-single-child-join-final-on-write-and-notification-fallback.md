# 0222. Single-child join: final-on-write report, stale-artifact check and notification fallback

## Status

Accepted — 2026-11-01 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462), follow-up slice A deferred from PR 2998).

Amends [0218](0218-slice-a-cap-round-chain-and-single-child-join.md) item 4. Accepted records remain unchanged.

## Context

ADR 0218 item 4 joins a single child with `gate wait-for-units --artifact`. For a full-phase fixer the outputRef is written by `verify-fixer-disposition.mjs --construct` before the verifier and `--check` finish, so the join can return while the fixer still runs. The 10-second stability window narrows that gap and makes the result depend on the caller's `--timeout`. A fixer that exits at step 3 or at a verifier refusal (`ci_failed`, `ci_pending`, `ci_unknown`) writes no artifact. A file left from an earlier dispatch reads as a finished child.

## Decision

1. Final-on-write. `verify-fixer-disposition.mjs` takes `--report-path <absolute path>` for normal verification and `--check`. It publishes its final result once, last and atomically (temp file, then rename): the result with `outcome` `complete` or `incomplete`, or on a refusal `{ ok: false, outcome: "refused", error }`. It refuses `--report-path` with `--construct` and when the path equals the handoff outputRef. A full-phase fixer order derives the path as `<outputRef>.report`, exposes it as `joinRef`, and step 6 (`--check`) passes it. The coordinator joins on `joinRef`, which exists only after the last verifier step. The 10-second stability window remains for `commit_only` site coverage records and other hand-back types with no terminal field.
2. Stale artifact. `--artifact` requires `--after <absolute path>`, a reference file written before dispatch (the emitted fixer plan, or for a delta reviewer the `input.patchPath` file). An artifact whose mtime is older than the reference is pending and the result reports `stale: true`. The rule that the hand-back path must not exist at dispatch stays.
3. Notification fallback. A full-phase fixer that exits before step 6 writes no report. After one `timeout` outcome of the fixer join, the coordinator ends its turn once to receive the fixer completion notification, treats it as the join, reads the typed exit code from the hand-back text and does not repeat the wait. Pi child calls block, so Pi needs no fallback.

## Consequences

The full-phase join is final on its first write and independent of `--timeout`. A stale file no longer reads as a finished child. A fixer exit with no report has a bounded, agent-runnable remedy.
