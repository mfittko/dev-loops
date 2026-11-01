# 0222. Single-child join: final-on-write report, stale-artifact check and notification fallback

## Status

Accepted — 2026-11-01 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462), follow-up slice A deferred from PR 2998).

Amends [0218](0218-slice-a-cap-round-chain-and-single-child-join.md) item 4. Accepted records remain unchanged.

## Context

ADR 0218 item 4 joins a single child with `gate wait-for-units --artifact`. For a full-phase fixer the outputRef is written by `verify-fixer-disposition.mjs --construct` before the verifier and `--check` finish, so the join can return while the fixer still runs. The 10-second stability window narrows that gap and makes the result depend on the caller's `--timeout`. A fixer that exits at step 3 or at a verifier refusal (`ci_failed`, `ci_pending`, `ci_unknown`) writes no artifact. A file left from an earlier dispatch reads as a finished child.

## Decision

1. Final-on-write. `verify-fixer-disposition.mjs` takes `--report-path <absolute path>`, valid only with `--check` (parse time and function both refuse it otherwise, naming the remedy: pass `--check`, or drop `--report-path`). It publishes its final result once per successful step-6 run, last and atomically (temp file, then hard link; an existing report is never replaced and a later run with the same path refuses): the result with `outcome` `complete` or `incomplete`, or on a refusal `{ ok: false, outcome: "refused", error }`. It also refuses the path when it equals the handoff outputRef. A failed publish never replaces the original refusal error. A full-phase fixer order derives the path as `<outputRef>.report`, exposes it as `joinRef`, and step 6 (`--check`) passes it. The coordinator joins on `joinRef`, which exists only after the last verifier step. The 10-second stability window remains for `commit_only` site coverage records and other hand-back types with no terminal field.
2. Stale artifact. `--artifact` requires `--after <absolute path>`, a reference file written before dispatch (the emitted fixer plan, or for a delta reviewer the `input.patchPath` file). An artifact whose mtime is older than the reference is pending and the result reports `stale: true`. The rule that the hand-back path must not exist at dispatch stays. Re-emission rewrites the plan and invalidates the previous fixer's join, so the coordinator joins only the latest emission; a stale timeout tells a fixer to check that `--after` and the join path come from the latest emission and to re-emit if not, and tells a delta reviewer to use a fresh `--result` path with the current `input.patchPath` as `--after`.
3. Notification fallback. A full-phase fixer that exits before step 6 publishes the report (step 3 CI exit, step 4 construct failure, step 5 refusal or `ok:false`, a crash) writes no report. After one `timeout` outcome of the fixer join, the coordinator ends its turn once to receive the fixer completion notification, treats the final notification as the join (an interim or not-reported-yet notification is not the join: it ends the turn again and waits for the final one), re-runs the same join once with `--timeout 0` and acts on the published report when it returns `all_done`, otherwise acts on the hand-back text or typed code it carries, and does not repeat the wait. The timeout remedy is split by hand-back type: every `--artifact` join except the full-phase fixer (the delta reviewer and the `commit_only` fixer) re-runs and returns `units_stalled` after three timeouts; a full-phase fixer ends the turn once. Pi child calls block, so Pi needs no fallback.

## Consequences

The full-phase join is final on its first write and independent of `--timeout`. A stale file no longer reads as a finished child. A fixer exit with no report has a bounded, agent-runnable remedy.
