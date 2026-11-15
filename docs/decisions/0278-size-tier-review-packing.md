# 0278. Size tiers pack review angles per unit, and Claude angles follow their own tier

## Status

Accepted — 2026-11-15 ([issue 3166](https://github.com/mfittko/dev-loops/issues/3166)).

Amends [0095](0095-single-wave-gate-fanout.md), [0111](0111-reviewer-unit-budget-scales-with-diff-size.md), [0072](0072-emitter-dispatches-autochunk-bundles-grouped.md), [0071](0071-review-proportionality-non-overridable-floors.md) and [0266](0266-claude-role-models-resolve-at-dispatch-time.md). Accepted records remain unchanged. Cites [0211](0211-light-mode-weighted-logic-loc-scope.md) and [0212](0212-lightweight-startup-uses-shared-light-mode-cap.md).

## Context

ADR 0095 fixed the reviewer unit bound at 5 angles for every repo and harness. ADR 0111 set the unit budget formula. ADR 0072 made the emitter cap-split units above the bound. ADR 0071 defined the proportionality plan. A small change therefore pays the grouping overhead of a large one, and a repo cannot ask for fewer runners on a micro diff. ADR 0266 pinned every Claude review angle to the `review` role model, so a mechanical angle cannot run on a cheaper tier. Slice 1 of issue 3166 made every bound consumer read the round's recorded bound. See [issue 3166](https://github.com/mfittko/dev-loops/issues/3166).

## Decision

1. `gates.fanout.sizeTiers` is an opt-in ordered list of tiers with `maxWholeLogicLoc`, `maxAnglesPerUnit` (5 to 10) and an optional `maxFiles`. Absent key keeps today's grouping.
2. `resolveFanoutSizeTier` (`packages/core/src/config/config.mjs`) selects the first tier at or above the round's weighted `wholeLogicLoc`. A tier applies only on `draft_gate` and `pre_approval_gate`, with no `gate:full` label and no escalation, a `pass` and T1-clean size outcome, readable, classifiable changed files that touch no risk path and no config source, and a passing tier `maxFiles`. `write-gate-context` treats a round that light mode would run inline as escalated, because such a round reaches fan-out only through an inline escalation. Every other case keeps existing grouping and records a reason (`unclassifiable_diff` when a changed file has no classification). A same-head rebuild without size evidence reuses the recorded applied tier, so the membership stays round-stable. A tier whose packed unit count exceeds the effective `maxConcurrent` is discarded (`over_concurrency`) and the single-wave capacity path runs. A round without an applied tier uses the default unit bound of 5.
3. `resolveFanoutDispatch` packs whole base units per resolved model into units of at most the tier bound. It records that bound as `fanout.unitBound` and the plan as `fanout.sizeTier`. Verification re-derives the unpacked base units. A base unit that mixes models keeps existing grouping.
4. Configuration validation rejects `mode: per-angle` with `sizeTiers`, an empty `sizeTiers` list, tiers that are not strictly ascending and a `maxAnglesPerUnit` outside 5 to 10. The tripwire lists `gates.fanout.sizeTiers` as a proportionality field.
5. This repository opts in with one tier: `maxWholeLogicLoc: 40`, `maxAnglesPerUnit: 10`, no `maxFiles`. The values are unmeasured starting policy.
6. A Claude review angle resolves its model with `resolveRoleModel(config, { role: angle, harness: "claude", kind: "angle" })`, as Pi does, except that Claude honors only the angle's `tier`: a concrete angle `model` is a harness-specific string and applies on Pi only. The per-angle knobs are `gates.<gate>.angles[].tier` and `.model`, never `models.roles[angle]`. The default is the repo's `models.roles.review` or `models.roleTiers.review`, else the high tier, so the repo-level review override that Claude honored before still applies. This fallback is Claude-only, and Pi and Codex resolution is unchanged. This amends ADR 0266 and issue 3133 AC3. A mixed-tier selection splits by tier, because a size-tier unit never mixes models. This choice is provisional and the operator may revert it. A unit outside a size tier whose angles resolve to different models dispatches at the `review` role model.

## Consequences

- A small eligible round dispatches fewer reviewer units. Each unit counts as one reviewer and gives one opinion.
- A unit above 5 angles keeps the slice 1 budget step of ADR 0111, clamped at the existing cap.
- First-fit decreasing packing can exceed the minimum feasible unit count for unusual sets.
- A repo that sets an angle's tier sees that angle run on that tier on Claude. A repo that sets none sees no change.
- Rejected: raise `REVIEWER_UNIT_MAX_ANGLES` globally. It changes every repo and harness.
- Rejected: run a mixed-tier unit at the highest tier among its angles. It needs a tier ranking and lets a low-tier angle run at the high tier unseen.
