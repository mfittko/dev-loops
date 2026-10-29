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
- Lightweight startup eligibility still reads raw counts and is outside this decision.
