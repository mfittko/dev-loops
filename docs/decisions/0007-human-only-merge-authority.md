# 0007. Keep merge human-only: separate final approval from merge authorization, hardened as non-overridable humanMergeOnly

## Status

Accepted — 2026-05-29 ([PR 179](https://github.com/mfittko/dev-loops/pull/179))

## Context

The final-approval flow could collapse a clean formal PR approval and consent to merge into a single transition, so an autonomous loop that reached a clean final review verdict could treat it as implicit permission to merge ([PR 179](https://github.com/mfittko/dev-loops/pull/179)). Even after that split, merge remained a soft gate: `autonomy.stopAt` defaulted to `["merge"]`, but a per-run `mergeAuthorized` envelope flag or an explicit "merge" instruction could still clear the agent to run `gh pr merge` itself, which conflicts with repos whose organizational rule is that a human must always perform the merge ([issue 910](https://github.com/mfittko/dev-loops/issues/910)). The hardening landed as `autonomy.humanMergeOnly` with a single authoritative resolver gating both the lifecycle chokepoint and the queue driver ([PR 921](https://github.com/mfittko/dev-loops/pull/921)); the enforcement lives in `packages/core` (`resolveEffectiveMergeAuthorized` in `src/config/config.mjs`, `resolveLifecycleState` in `src/loop/lifecycle-state.mjs`).

## Decision

We keep final approval and merge authorization as distinct, machine-checkable states: an approval-only outcome parks the loop at a dedicated `waiting_for_merge_authorization` gate and never implies merge. We further make human-only merge a repo-level invariant, not a per-run default: when `.devloops` sets `autonomy.humanMergeOnly: true`, the agent never runs `gh pr merge`, `resolveEffectiveMergeAuthorized` returns `false` regardless of any per-run authorization signal, and `resolveAutonomyStopAt` always includes `merge` even when config declares `stopAt: []`. The gate fails closed throughout — a non-boolean authorization signal denies merge, and a config that fails to load or validate denies merge rather than falling back to a config that might lack the invariant. `resolveLifecycleState` computes the effective authorization the same way, so the loop parks at the pre-approval-gate human handoff instead of advancing to the terminal merge action, and the queue driver routes its merge-authorized flag through the same resolver. We rejected the alternative of keeping merge a soft gate that explicit instruction can unlock: an enforced invariant cannot be talked past, a default can.

## Consequences

The loop is autonomous up to, but never through, merge — the one boundary that neither config nor runtime flags can loosen when the invariant is set. All queue, conductor, and hook automation terminates at the human-merge handoff: the agent still runs the mechanical pre-merge evidence check and reports merge-ready, but the final merge is always a human action. Merge-adjacent features must build against this invariant and route any "cleared to merge" decision through the authoritative resolver rather than reading raw authorization flags. Fail-closed behavior means a broken `.devloops` file silently withholds merge authorization, which is the intended trade: a stalled loop is recoverable, an unattended merge to main is not.
