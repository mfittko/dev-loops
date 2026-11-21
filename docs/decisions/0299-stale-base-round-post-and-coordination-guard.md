# 0299. A clean verdict posts with a stale-base line when only the base moved, and coordination guards the ready routes

## Status

Accepted, 2026-11-20 ([issue 3346](https://github.com/mfittko/dev-loops/issues/3346)).

Amends [0284](./0284-stale-base-preflight-in-validation-and-verdict-seams.md) decision point 2. Record 0284 stays unedited.

## Context

ADR 0284 makes `upsert-verdict` refuse a clean `draft_gate` or `pre_approval_gate` verdict at a stale head. When the base moves while a round runs, the refusal discards a round whose head held the base when it started. The base-merge carry of ADR 0156 can decide whether that verdict stands at the merged head, but only if the verdict is posted.

## Decision

1. `upsert-verdict` posts the clean verdict when the head is stale and a same-head gate context for this gate records `baseFreshness.status` `base_current` for the PR base, found in the reviewed worktree (a context in another checkout belongs to an earlier round and is no proof). Every same-head round's `write-gate-context.mjs` refuses at a stale base, so that context proves the head held the base when it was written. The post carries a `**Base freshness:** stale` line that names the newer commits and the base-merge remedy. With no such context, an unreadable context or a context for another base, the refusal of 0284 stands. The converged and cap-round catch-up posts keep the refusal.
2. `loop gate-coordination` runs the `GATE-EXEC-BASE-REFRESH` freshness check before `mark_ready_for_review` and `await_final_human_approval`, as it already does before `run_draft_gate` and `run_pre_approval_gate`. A stale head routes to `resolve_merge_conflicts`, so a clean verdict posted with the stale line never reaches ready or merge without a base merge in a lane that consults `loop gate-coordination`. `merge-pr` and `ready-for-review` run no base freshness check of their own, so a caller that runs them directly is unguarded.

## Consequences

- A base move during a round no longer costs the round when the base-merge carry holds.
- The stale line stays on the posted verdict as a visible record.
- Coordination adds one git comparison before two more actions. A fetch failure keeps the action, as before.
- Any PR whose head lacks the base, including one whose base moved after a clean verdict, merges the base before the ready flip or final approval, and runs a full new round when the carry refuses.
