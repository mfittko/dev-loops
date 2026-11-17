# 0262. Ground optional judge discovery before opening paths

## Status

Accepted — 2026-11-10 ([operator acceptance](https://github.com/mfittko/dev-loops/issues/3176#issuecomment-6778873101))

## Context

A judge reviewing a consumer repo selected guessed optional paths and then correctly stopped when the reads failed. [Issue 3176](https://github.com/mfittko/dev-loops/issues/3176) decides how to prevent ungrounded path selection without weakening those stops.

## Decision

Register [GATE-EXEC-JUDGE-GROUNDED-DISCOVERY](../../skills/docs/gate-review-sub-loop-contract.md#phase-35--judge-relevance-disposition-1525) in the gate-review contract and carry its five clauses in the canonical judge role and emitted `executionRules.widening` text. The canonical rule owns the clauses: when existing evidence suffices, do not read an absent optional candidate; when necessary evidence is unavailable, report that limitation and stop.

The emitted rule text is the single delivery surface: the pulled work order carries it and tests inspect the materialized bytes. It adds no tool grant, shell command or write target. Reject a new search service or wrapper language, a denylist of guessed names, and wider permissions: each adds surface without establishing grounded path selection.

## Consequences

Optional reads must have a concrete reason and a grounded path under the correct root. Empty optional discovery can leave sufficient existing evidence intact; unavailable necessary evidence still stops the judge. Deterministic tests establish delivery only, while isolated native evaluation records observed behavior or its precise limitation without claiming universal model reliability.
