# 0326. A draft_gate round runs at a stale base, and only the pre_approval_gate refreshes it

## Status

Proposed. Becomes Accepted on operator approval ([issue 3571](https://github.com/mfittko/dev-loops/issues/3571)).

Amends [0096](./0096-integrate-base-before-every-gate-round.md) (as amended by [0296](./0296-narrow-base-merge-carry-gate-tooling-rule.md), whose carry classifier is unchanged), [0194](./0194-stale-base-preflight-on-lifecycle-gates.md), [0260](./0260-gate-coordination-reroutes-stale-base.md) and [0284](./0284-stale-base-preflight-in-validation-and-verdict-seams.md) (as amended by [0299](./0299-stale-base-round-post-and-coordination-guard.md)) for the `draft_gate` scope. Those records stay unedited.

## Context

`GATE-EXEC-BASE-REFRESH` refuses every `draft_gate` and `pre_approval_gate` round at a stale head. Each merge to the base branch costs every open lane a base merge, a CI wait and often one more dispatch. In v1.0.12, 44 merge commits from the base went into 25 branches, and one lane stopped when the classifier denied the base merge.

A `draft_gate` round reviews `git diff origin/<base>...HEAD`, the merge-base diff, which holds only the PR's own changes at a stale head as well as a current one. CI runs on the PR merge ref as of the last push. Conflicts route to conflict resolution with or without the freshness check. The `pre_approval_gate` reviews the final head in full (`GATE-EXEC-REGATE-MANDATORY`).

## Decision

1. `write-gate-context.mjs` refuses a stale head for the `pre_approval_gate` only. A `draft_gate` context records `base_stale_integrate_first` and continues, as the `review` gate does. A `draft_gate` context still refuses `base_fetch_failed` and `base_head_unresolved`: after a failed fetch the merge-base diff uses the local `origin/<base>`, which can be older than a base tip the PR branch already merged, so the diff would hold base commits as PR changes.
2. `upsert-verdict` runs the stale-base refusal and the ADR 0299 stale-line path for the `pre_approval_gate` only. A clean `draft_gate` verdict records at a stale head with no stale line. The draft-only refusal code (the early check before the draft conversion, and the converged and cap-round head branches) is deleted.
3. `pr reconcile-draft` runs no base check and takes no `checkBaseFreshness` option.
4. `gate resolve-validation --gate draft_gate` runs validation at a stale head. Every other gate keeps the stale-base result. The validation-block difference refusal still applies to a `draft_gate` run, and at a stale head its reason also names the stale base and the base merge remedy.
5. `loop gate-coordination` runs the freshness check before `run_pre_approval_gate` and `await_final_human_approval` only. `run_draft_gate` and `mark_ready_for_review` keep their action at a stale head.

`merge-pr` keeps its `base_not_integrated` refusal. The `review` gate, `ready-for-review`, `resolve-pr-conflicts.mjs` and `GATE-EXEC-BASE-MERGE-VERDICT-CARRY` are unchanged. No mode, flag or persisted state is added.

## Consequences

A `draft_gate` round can review a head that lacks the newest base commits. The refresh still covers two risks, and the `pre_approval_gate` round at a current base runs before any merge:

- A base change can break the PR without a textual conflict, and CI on the merge ref is only as fresh as the last push.
- A stale head runs older gate tooling, because the coordinator runs the PR worktree's scripts. ADR 0096 records the case where a `pre_approval_gate` at a stale head composed `clean` over act items.

A draft round at a stale head can need a re-run after the base merge that the `pre_approval_gate` requires. That cost replaces one base merge, one CI wait and one dispatch per open lane per base move.

Revert by restoring the two-gate refusal set at the five seams.
