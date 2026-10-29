# 0211. Light mode scope uses weighted logic LOC and a non-doc file count

## Status

Accepted — 2026-10-29 ([issue 2982](https://github.com/mfittko/dev-loops/issues/2982), operator ruling on the issue)

Refines the light-mode size cap of `GATE-EXEC-PROPORTIONALITY` in the gate review sub-loop contract. Every other floor of that rule stays in force.

Amends ADR 0108 (light mode scope count excludes fragments and mirrors). It replaces the raw `filesChanged`/`linesChanged` cap input and the rejected alternative "Filter inside resolveGateDispatchMode": the resolver now filters inside `resolveGateDispatchMode` and caps on `wholeLogicLoc` and the non-doc file count.

## Context

`resolveGateDispatchMode` compared raw diff lines and raw file counts with `lightMode.maxLines` and `lightMode.maxFiles`. Most small fixes carry a test and a doc note, so raw counts sent nearly every micro-PR to full fan-out. PR 2981 had 13 weighted logic LOC and 62 raw lines across 3 counted files, and it ran full fan-out. The size budget already weights the diff, and the resolver already receives that outcome as `sizeOutcome`.

## Decision

- The line cap compares the size outcome's `wholeLogicLoc` with `lightMode.maxLines`.
- The file cap counts every changed file except doc files and the existing scope-count exclusions. Config, CI and asset edits still count.
- The risk-path floor is unchanged. Every changed file, including docs, still goes through `touchesRiskPath`.
- A missing or invalid `wholeLogicLoc` fails closed to full fan-out (`size_outcome_unavailable`).
- The `maxFiles` and `maxLines` values and the size budget weights stay as they are.

## Consequences

- Small code-and-test fixes with doc notes reach the inline light track.
- A large doc-only change outside the risk paths can go inline. This is accepted.
- Config, CI and asset files count toward the file cap but add no weighted lines. A large edit to one or two such files outside the risk paths can go inline. This is accepted.
- Lightweight startup eligibility calls the same `lightModeCapState` helper as `resolveGateDispatchMode` (issue 2985). Startup measures the base-to-working-tree diff for weighted LOC. The `eligibleForLightMode` field of `scripts/loop/detect-change-scope.mjs` is informational and still reads raw counts.
- The floor for a touched dev-loop config source (`config_source_touch`) applies at gate dispatch and at startup, because the head config's `classify` rules feed both cap inputs.
- Renames count both endpoints, because the name list comes from a `--no-renames` diff.
- Startup eligibility fails closed with `size_outcome_unavailable` when the weighted LOC is missing or the size capture fails. The gate dispatch CLI reaches the same state for a `--base`-only run, where the three-dot size reader cannot measure the working tree.
