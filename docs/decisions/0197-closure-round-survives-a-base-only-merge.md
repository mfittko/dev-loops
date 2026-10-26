# 0197. The closure round survives a base-only merge

## Status

Accepted — 2026-10-26 ([issue 2937](https://github.com/mfittko/dev-loops/issues/2937) S4b)

Amends [ADR 0191](./0191-past-cap-judge-disposition-of-a-medium-is-final.md) for the count of a head that only merges the PR base after the cap round and for the diff of the closure round. All other decisions of ADR 0191 are unchanged. The record of ADR 0191 stays unedited.

## Context

On PR 2944, the `draft_gate` cap round 4 at `e869fb2f8f8ac9c425bd703ea4bbe8aa0e158623` held 2 medium and 3 low act items with judge-specified remedies. The branch then merged `origin/main` (head `1da7a33`, empty PR-own delta). The merged head has no ledger, so `countCompletedRounds` counted it as round 5, and `emit-fixer-work-order.mjs` refused the cap-round act list with `round_cap_reached`. The closure round diffed from `fromHead` and held the content of `main` and none of the PR's own files, so the gate coordinator stopped with `closure_delta_excludes_pr_content`.

## Decision

- Base-only merge. A head whose commits after the cap-round head are all merges (apart from commits already on `origin/<base>`) and whose main-relative PR-own delta since that head is empty is a base-only merge. The check reuses `captureMainRelativeChangedFilesSince` (`scripts/lib/git-delta.mjs`), the classifier of the carry-forward rule, through `isBaseOnlyMergeSince`.
- Count. A base-only merge neither counts as a round nor consumes the closure round. `emit-fixer-work-order.mjs` treats such a head, which has no ledger of its own, as the cap round: it reads the cap-round ledger and the posted verdict at the cap-round head, and emits the closure fixer order at the current head. When the PR-own patch changed since the cap-round head, or the base cannot be resolved, every `round_cap_reached` refusal stays.
- Closure diff. The closure round diffs from `fromHead` and restricts the diff, the changed files and the adjacent code to the PR-own files since `fromHead`, so the content of a merged base is excluded. When the PR-own delta since `fromHead` is empty, or cannot be proven, `write-gate-context.mjs` refuses with `closure_delta_no_pr_own_change` and writes no artifact, so the round never composes `clean`.

## Consequences

A PR at the cap round that merges its base can continue through the fixer pass and the closure round without an operator line. A PR that changed its own patch after the cap round is still counted by its ledgers. A closure round over a base-only merge refuses with a typed code in place of an unreviewable bundle.

Known ceilings. `isBaseOnlyMergeSince` returns false when the merged base touches a file the PR also changes. It fails closed and keeps `round_cap_reached`. An overlapping file in the closure diff may still carry merged base hunks. A rename source is not in the closure pathspec.
