# 0322. Cap brakes and the scoped final round

## Status

Accepted — 2026-11-25 ([issue 3357](https://github.com/mfittko/dev-loops/issues/3357), with issue 3566, issue 3464 and the soft-cap rows of issue 3105 folded in). Amends ADR 0208, ADR 0251 and ADR 0320. Slice 1 covers `pre_approval_gate` and the shared brakes. Slice 2 moves the `draft_gate` exit and deletes the cap exit of ADR 0320.

## Context

A gate lane kept fixing while the diff grew and the findings did not shrink. `pre_approval_gate` had no round cap, and PR 3307 ran 8 rounds. Two consumer PRs ran 6 and 7 rounds unattended for about 16 hours, grew from forecasts of about 600 and 320 wloc to about 4700 added lines each, and read every `blocked` verdict as "fix more" although only PR-body checkboxes were unticked. PR 3447 grew from +96 to +2641 lines against a 120 line forecast, because nothing enforced the growth stop of `GATE-EXEC-FIXER-CYCLE-BOUND`.

## Decision

- One pure policy, `decideCapRound` in `packages/core/src/loop/review-round-cap.mjs`, serves both gates. It returns `full_round`, `scoped_final_round` or `operator`, and an `operator` result names a reason (`round_cap_reached`, `cap_fix_over_budget`, `non_convergence`, `growth_past_forecast`) and the numbers.
- `gates.preApproval.maxReviewRounds` defaults to 2 (`0` disables the cap). `gates.capFixMaxLines` defaults to 60.
- After cap round N, a fix is allowed only within the fix budget: the logic LOC of the PR-own diff since the cap-round head is at most `gates.capFixMaxLines` and the diff adds no file. Then one scoped final round runs at the exact new head. Its bundle holds only the PR-own diff since the previous round head, and its reviewers also answer "Does this diff add behavior beyond the finding?". A yes is a finding. The scoped round posts a normal verdict, and a clean verdict is the exit, the same clean evidence as any other round. No delta record is final-gate proof.
- Past the cap, every finding of a scoped round, a fix over the budget and each brake stop goes to the operator with the item named. The operator clears a stop only through an operator focus item with a `decision` that names the act item by fingerprint (`GATE-EXEC-OPERATOR-FOCUS`, ADR 0320).
- The `non_convergence` brake compares the act count of a round only against the previous round that held act items. A round after a clean round (previous count 0) restarts the count. This deviates from a plain "two rounds in a row" reading, because a clean round proves convergence.
- An operator clear opens one more scoped round for each distinct act-item fingerprint set (Option 2). The clear counts only when the issued fixer plan binds to the latest closed round head, to `pre_approval_gate` and to its work order digest, and holds a decision for each fingerprint. A set that an earlier round held from the round after the effective cap round on already had its one re-open and stays with the operator.
- A round forced by a base merge (its head follows the previous round head by merges only) does not count toward the `pre_approval_gate` cap.
- A `blocked` verdict names its causes in a `**Blocked by:**` line (`findings`, `unticked_checkboxes`, `size_budget`, `ci`). When no cause is `findings`, the derived next action is the operator step and the fixer emitter refuses a fix round with `blocked_without_findings`.
- No new persisted state, no new local record and no `.devloops` change. The facts come from the round ledgers, the posted reviews and git.

## Consequences

A lane that does not converge stops with a named question for the operator within a bounded number of rounds and a bounded fix size. The scoped round reuses the closure round code of ADR 0191 that had no call site. The cost is one more round after the cap and an operator answer when the scoped round finds anything.

## Alternatives

- A sealed delta review after the cap round keeps a delta record as final-gate proof, which the 2026-11-22 decision withdrew.
- A full third `pre_approval_gate` round finds edge cases in the code the last fix added.
- A separate cap module for `pre_approval_gate` doubles the draft cap code that issue 3524 and issue 3461 delete.
- The `gate extend-cap` marker of issue 3105 adds a marker grammar and an authorization record. The operator focus decision already binds an operator answer to named items.
