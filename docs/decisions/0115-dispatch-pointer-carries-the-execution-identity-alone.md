# 0115. The dispatch pointer carries the execution identity alone

## Status

Accepted — 2026-09-29 ([issue 2551](https://github.com/mfittko/dev-loops/issues/2551))

Amends [ADR 0106](./0106-workers-pull-deterministic-work-orders.md): that record puts `workOrderRef`, `workOrderDigest` and `executionIdentity` into the dispatch envelope. This record puts the execution identity alone into the envelope. The pull resolves the ref and the digest from the emitter's execution index. The binding keys of [ADR 0107](./0107-fixer-mutation-authority-bound-to-pulled-work-order.md), which amends ADR 0106, stay unchanged.

## Context

The dispatch pull line carried three values for every role. The long line invited edits. On PR 2546, every fixer appended `; echo "EXIT $?"` to it. The Bash gate records the fixer's agent binding only for the exact pull line, so the pull wrote a receipt with no binding marker. The Write/Edit guard then denied every edit with no hint about the cause.

## Decision

- The dispatch pointer is ``Run `dev-loops-run scripts/github/pull-work-order.mjs <executionIdentity>`; follow its printed work order exactly. Exit 1: report its JSON verbatim, stop.`` `DISPATCH_POINTER_MAX_BYTES` stays 499.
- `EXECUTION_IDENTITY_RE` in `packages/core/src/loop/work-order-digest.mjs` is the one execution identity shape: `r<ms>-<8 hex>-u<n>` for a review unit, `j<ms>-<8 hex>` for a judge round and `f<ms>-<8 hex>` for a fixer execution. `buildDispatchPointer` refuses any other identity.
- Each emitter writes one execution index entry `{ executionIdentity, workOrderRef, workOrderDigest }` per emitted unit to `<tmp root>/work-order-executions/<executionIdentity>.json`, beside its emit plan, with the `wx` flag. An existing entry with other content refuses the emission. The emit plans are unchanged and stay the authority.
- `pull-work-order.mjs <executionIdentity>` reads the entry from every tmp root it searches. No entry is `dispatch_reference_mismatch` (retryable). Two different entries are `local_materialization_integrity_failure`. An identity whose prefix role differs from the entry's ref role is `dispatch_identity_mismatch`. The resolved ref and digest then enter the ADR 0106 checks unchanged, and the receipt shape is unchanged.
- Hard cut: the pull refuses `--ref`, `--digest` and `--execution` with exit 2 and the usage text.
- One regex in `packages/core/src/claude/hook-decisions.mjs` defines the sanctioned pull line (`parseSanctionedPullLine`). The fixer binding resolves the ref and digest from the execution index under the main checkout's `tmp/`. From the `fixer` agent, the Bash gate denies a command that invokes `pull-work-order` with a fixer identity but is not the exact line, and the reason prints the exact line to run alone.

Rejected: accepting a modified pull line by stripping suffixes (the exact-line match stays the security boundary); a transition period that accepts the 3-flag form.

## Consequences

The pull line is short and has one variable word. A modified fixer pull line denies at the Bash gate with the recovery, so a fixer no longer pulls without a binding. An execution emitted before the upgrade has no index entry, so its pull refuses and the coordinator re-emits the round.
