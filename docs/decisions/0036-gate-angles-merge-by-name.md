# 0036. Merge gate angle configuration by name across config layers so consumers carry deltas only

## Status

Accepted — 2026-07-18 ([PR 1413](https://github.com/mfittko/dev-loops/pull/1413))

## Context

Before the redesign, a gate-review angle's identity was spread across five separate config places (`angles` names, `mandatoryAngles`, `excludeAngles`, a top-level `personas` map, and angle-keyed model overrides), and consumer arrays replaced the shipped pool wholesale — so changing a single angle meant copy-pasting and maintaining the entire shipped array, and a byte-for-byte restatement of a shipped entry silently pinned it, masking upstream updates. The pre-1.0 window was the last chance to break the schema, and the redesign landed 2026-07-18 via [PR 1404](https://github.com/mfittko/dev-loops/pull/1404), merged to main as [PR 1413](https://github.com/mfittko/dev-loops/pull/1413). The composition rule is specified in `skills/docs/gate-review-sub-loop-contract.md` (angle-pool resolution) and implemented as the `GateAngleEntry` schema in `packages/core/src/config/config.mjs`; this repo's own `.devloops` was rewritten to demonstrate the deltas-only shape.

## Decision

We collapse each gate's angle configuration into one `gates.<gate>.angles` array of angle objects — a bare string is sugar for `{ name }`, and one entry carries `mandatory`, `enabled`, `persona`, `prompt`, `model`, and `tier` — and we merge that array BY NAME across config layers instead of replacing it. A consumer adds a new angle, overrides a shipped one, or disables one with `enabled: false` by naming just that entry, never restating the shipped pool. A disabled entry is a hard ceiling: even additive dynamic resolution (`gates.<gate>.dynamic.additive`) never re-adds an excluded angle, while entries with `mandatory: true` form a floor that dynamic pruning never drops. We rename the dynamic-angle knobs (`dynamicAngles`, `additiveAngles`) under `gates.<gate>.dynamic.subtractive`/`.additive`, and we validate each entry against the one `GateAngleEntry` object schema so a malformed entry fails with a precise field path. We reject the alternative of keeping the five parallel keys with whole-array replacement semantics — that model is exactly what forced full-pool copy-paste and silent upstream masking.

## Consequences

Consumer configs stay small and pick up upstream angle improvements automatically, because an untouched shipped entry keeps flowing through instead of being frozen by a stale local copy; this repo's `.devloops` now carries only its real deltas (two disabled draft angles, promoted-to-mandatory and added preApproval angles). Dropping an angle now requires an explicit `enabled: false` — omitting the entry merges it back in — a semantic contributors must know, and byte-identical restatements of shipped entries are no-ops that get trimmed. Merge-by-name is now the composition rule every future config layer follows for angles, and downstream enforcement (mandatory-angle coverage, foreign-angle rejection, the additive lens catalog) reads from this single resolved pool.
