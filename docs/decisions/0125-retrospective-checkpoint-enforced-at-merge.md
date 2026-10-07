# 0125. The retrospective checkpoint is enforced at merge

## Status

Accepted — 2026-10-07 ([issue 2488](https://github.com/mfittko/dev-loops/issues/2488))

## Context

Amends [0024](./0024-retrospective-advisory-reversal.md). Record 0024 decided that the retrospective never blocks merge or any PR-lifecycle transition, and that a future blocking proposal must supersede it. This record amends 0024 by narrowing its never-block rule; 0024 stays in force. Retrospective findings stay advisory. Record 0024 stays unedited.

The checkpoint gate was repo-global and sat at loop startup. One merged unit with an undischarged retrospective returned `needs_reconcile` for every other unit, although the units were independent. Evidence is in [issue 2488](https://github.com/mfittko/dev-loops/issues/2488): the pending retrospective for PR 2679 stopped startup for PRs 2686 and 2687. A retrospective can run in parallel with unrelated work, so the startup block bought no safety.

## Decision

We move enforcement of the checkpoint completion state from startup to `merge-pr`.

- Startup routes a unit normally when the checkpoint is missing. The startup bundle reports the obligation as `pendingRetrospectives`, a list of `{ pr, mergeCommit }` entries. An entry whose merge cannot be identified carries `pr: null`, `mergeCommit: null` and a `reason` code. The orchestrator dispatches each reported retrospective in parallel with the unit.
- `merge-pr` adds the precondition `retrospective_checkpoint`. It refuses while an earlier qualifying merge has no `complete` or `skipped` checkpoint. The refusal names the PR number and full merge commit of each entry, or the reason code and recorded checkpoint state for an entry with no identity.
- One shared evaluator owns the read, the repo-identity check, the qualifying-merge rule and the state mapping. Startup and `merge-pr` both call it, so the two gates cannot disagree.
- Both sites stay gated on `workflow.requireRetrospective`. With the flag unset or `false`, neither site reads the checkpoint file or runs the ancestry lookup.
- The qualifying-merge rule is unchanged: a PR merged into the configured base branch after the recorded merge commit.

The obligation moves from the start of the next unit to the merge of the next unit, so retrospectives run in parallel and cannot pile up.

Rejected alternatives: keep the startup block (idles independent units), and drop enforcement (lets retrospectives lapse silently).

## Consequences

Independent units start in parallel while a retrospective runs. A merge waits for the previous merge's retrospective to be recorded as `complete` or `skipped`. The completion state of the earlier merge's checkpoint is the only retrospective input that blocks a merge. Retrospective findings remain advisory. A record that cannot be read, parsed, or tied to this repository blocks the merge until it is re-recorded.
