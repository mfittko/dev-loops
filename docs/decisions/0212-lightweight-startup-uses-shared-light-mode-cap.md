# 0212. Lightweight startup eligibility uses the shared light-mode cap

## Status

Accepted — 2026-10-29 ([issue 2985](https://github.com/mfittko/dev-loops/issues/2985)).

Amends ADR 0211 (light mode scope uses weighted logic LOC and a non-doc file count). It replaces the 0211 consequence that lightweight startup eligibility still reads raw counts. Every other 0211 decision stays in force.

## Context

ADR 0211 moved the gate dispatch light-mode cap to weighted logic LOC and a non-doc file count. Lightweight startup eligibility kept comparing raw line and file counts, so one change could pass one check and fail the other.

## Decision

- Lightweight startup eligibility calls the shared `lightModeCapState` helper, the same one `resolveGateDispatchMode` calls. Startup measures the base-to-working-tree diff for weighted LOC.
- The `eligibleForLightMode` field of `scripts/loop/detect-change-scope.mjs` is informational and still reads raw counts.
- The floor for a touched dev-loop config source (`config_source_touch`) applies at gate dispatch and at startup, because the head config's `classify` rules feed both cap inputs.
- Renames count both endpoints, because the name list comes from a `--no-renames` diff.
- Startup eligibility fails closed with `size_outcome_unavailable` when the weighted LOC is missing or the size capture fails. The gate dispatch CLI reaches the same state for a `--base`-only run, where the three-dot size reader cannot measure the working tree.

## Consequences

- Startup and gate dispatch agree on light-mode eligibility for the same diff.
- A failed size capture sends startup to the non-lightweight path instead of guessing from raw counts.
