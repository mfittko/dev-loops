# 0208. The cap round's fixer pass is the last draft step and the PR goes ready

## Status

Accepted — 2026-10-29 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462) slice 8, operator ruling on the issue)

Reverses the closure round of `GATE-EXEC-ROUND-CAP` (count cap+1) that [ADR 0185](./0185-draft-gate-round-cap-and-post-convergence-no-code-commit.md), [ADR 0188](./0188-low-nit-never-block.md), [ADR 0189](./0189-draft-round-cap-counts-from-landing.md), [ADR 0191](./0191-past-cap-judge-disposition-of-a-medium-is-final.md) and [ADR 0197](./0197-closure-round-survives-a-base-only-merge.md) built. Every other decision of those records stays in force, and the records stay unedited.

## Context

The closure round ran one more full `draft_gate` round after the cap round's fixer pass. PRs 2922, 2960, 2961 and 2976 stopped there: the closure round found new items, composed `blocked` with `round_cap_reached`, and the only sanctioned exits were a cap raise, a waiver marker or a supersede.

## Decision

- Rounds 1 to N run, including the cap round N. A clean round stops early.
- The fixer runs on the cap round's judge-acted findings. Round N+1 never runs.
- After the cap round's fixer pass has landed and its pre-push delta has cleared or bounded out, gate coordination returns `mark_ready_for_review` and never `run_draft_gate`. `ready-for-review` accepts this "cap round fixed" state in place of a clean current-head verdict. CI, size, ADR tripwire and spec conditions stay fail-closed.
- `pre_approval_gate` stays the final full round. It receives the cap round's residue (act items the fixer did not close and the cap round's `capClosed` items) as round input.
- A PR that already holds a post-cap `blocked` draft verdict has the same transition. It needs no marker, cap raise or supersede.
- `round_cap_reached` remains only as the refusal of a round N+1 that is attempted anyway.

## Consequences

A capped PR leaves draft through the normal path and `pre_approval_gate` judges what remains. The closure-round code (`resolveClosureRound`, `scope.closureRound`, the closure diff and the `closure round:` verdict line) stays in place but is no longer reached: the context writer refuses a `draft_gate` context at count cap+1 with `round_cap_reached`, the post path refuses it for every post shape except an ADR 0168 converged post (`--converged-json`), which records convergence and runs no review round, and coordination returns `report_blocked` rather than `run_draft_gate` when the next round is past the cap and the cap round is not fixed. The "cap round fixed" proof is the cap-round ledger plus a sealed pre-push delta record bound to the cap-round head. A legacy delta record written before the seal has no seal and is no proof: rerun the pre-push delta for the cap-round baseline so the writer seals it. A ready PR keeps the proof whatever its later head, so the draft evidence guard never reconciles it. Removal ships in a later slice.
