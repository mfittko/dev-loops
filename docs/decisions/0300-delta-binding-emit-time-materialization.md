# 0300. The Delta binding authenticates the emitted materialization bytes and does not re-render

## Status

Accepted, 2026-11-21 ([issue 3371](https://github.com/mfittko/dev-loops/issues/3371)).

Amends [0150](./0150-pulled-coverage-delta-binding.md). Record 0150 stays unedited.

## Context

ADR 0150 binds the Delta input, result and closure runs to the pulled fixer unit. `authenticateCoverage` compared the prompt bytes hash with the plan hash, the pull receipt hash and the hash that `locateFixerUnit` re-renders from the current worktree. A fix that edits `scripts/loop/emit-fixer-work-order.mjs` changes that re-render, so every later Delta run refused with `materialization differs from actual bytes, renderer, plan or receipt`. The fix sequence and its push could not proceed.

## Decision

1. `authenticateCoverage` compares the hash of the prompt bytes at `work-orders/<executionIdentity>.md` with `plan.materializationHash` (recorded at emit time) and `pull.receipt.materializationHash` (recorded at pull time, after the pull verified the bytes against the renderer of that time). It drops the re-render term. The refusal text reads `materialization differs from actual bytes, plan or receipt`.
2. `planAuthenticationFailure` keeps checking the semantic `workOrderDigest`, role, target, phase, baseline and branch. `locateFixerUnit` still runs for its staleness, supersession and execution identity checks. The pull-time re-render in `pullWorkOrder` is unchanged.

## Consequences

- A fix that edits the fixer renderer completes the Delta review, the result run and the push.
- `authenticateCoverage` also checks that the prompt ends with the complete Work order JSON block rendered from `plan.workOrder`. This binds the fields the semantic digest drops (the `LOCAL_MATERIAL_KEYS` fields and absolute-path strings such as `executionRules.contract`) to the prompt bytes. It mirrors `authenticateOriginalPlan` in `scripts/github/_fixer-emission-evidence.mjs`, and both call one helper. The refusal text reads `materialization differs from the plan's work order`.
- Watchpoint: the check no longer proves that the prose before the Work order JSON block equals a render of `plan.workOrder`. A prompt, plan hash and receipt hash forged together with a matching suffix pass this check. Only the pull script writes the receipt, under the main checkout tmp root, so this narrowing is accepted.
- Watchpoint: a fix that changes the suffix format (the heading or the JSON serialization) refuses here, as `authenticateOriginalPlan` refuses it at completion.
- A re-pull of the same unit after a renderer edit still refuses `local_materialization_integrity_failure`.
