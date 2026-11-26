# 0334. A `ci_pending` verifier refusal publishes no join report

## Status

Accepted — 2026-11-26 ([issue 3518](https://github.com/mfittko/dev-loops/issues/3518)).

Amends [0223](0223-single-child-join-final-on-write-and-notification-fallback.md) item 1: the join report is final on write for every outcome except a `ci_pending` refusal, which publishes no report. [0277](0277-fixer-delivery-wait-cap.md) amended item 3 of the same record (the notification fallback) earlier and stays in force. Accepted records remain unchanged.

## Context

A full-phase fixer pushed a fix and ran the emitted `wait-pr-checks` step. The wait returned before the new head's checks registered. The step-5 verifier found no check run at the pushed head, passed it as check-less and resolved the review threads. The step-6 `--check` run then found the checks registered and pending. It refused with `ci_pending` and published a final refused report at the order's `joinRef`. A later run with the same `--report-path` refused with `EEXIST`, and `--completion-only` re-emission refuses because the outputRef postdates the pull. The coordinator had no sanctioned way to publish a report for the head once CI was green, and it stopped. Two causes met: the check-less rule cannot tell an unregistered head from a repo without CI, and a `ci_pending` refusal is a transient state that the final-on-write rule made permanent.

## Decision

1. A pushed head (`--head-sha`) with no non-loop-derived check run or status, and different from the work order head, is judged against the order head. The verifier reads the order head with the same `observeHeadCiSignals` call. When the order head has a non-loop-derived check run or status, the pushed head is `ci_pending`. When the order head has none, the existing check-less rule applies. When the order head read fails, the verifier fails closed: it refuses `ci_unknown` and publishes a final refused report. A pushed head equal to the order head keeps the existing rule.
2. A `ci_pending` refusal publishes no join report. Every other outcome (`complete`, `incomplete`, every other refusal, including `ci_failed` and `ci_unknown`) publishes once and stays final on write.
3. The `ci_pending` refusal text is the one place that states the recovery: run `wait-pr-checks` for the PR (re-issued under 0277), then rerun the same verifier command unchanged. The fixer follows the recovery once per order, and a second `ci_pending` refusal hands back `ci_pending` with the refusal text. The coordinator that finds a `ci_pending` hand-back with no report follows the same recovery with the order's emitted `--check` step, which is read-only and publishes the join report. When the pushed head never registers checks (for example a skip-ci commit or a path-filtered workflow in a consumer repo) and the coordinator's recovery also refuses `ci_pending`, the coordinator hands `ci_pending` back to the orchestrator with the refusal text, and the operator decides.
4. The check-less wait grace and the `wait-pr-checks` head handling are unchanged. The verifier is the authority that resolves threads, so its rule covers both wait paths.

## Consequences

- A head whose checks have not registered resolves no thread, and the lane no longer stops on a refused report.
- A refused report on disk from an earlier run stays final. No sweep rewrites it.
- Revert by restoring the publish in the `verifyFixerDisposition` catch block and removing the order-head read.
- Rejected: a longer no-checks grace (it misses the stale `headRefOid` path and slows check-less repos), a head flag on `wait-pr-checks` (it fixes only the wait), replacing a refused report (it breaks final-on-write for every refusal code) and re-emitting `--completion-only` after a refused report (a second delivery path for a case one `--check` rerun covers).
