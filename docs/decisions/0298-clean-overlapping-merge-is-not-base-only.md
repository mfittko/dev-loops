# 0298. A clean overlapping merge adds its overlap paths to the PR-own paths

## Status

Accepted, 2026-11-21 ([issue 3356](https://github.com/mfittko/dev-loops/issues/3356)).

Amends decision 3 of [ADR 0255](./0255-code-range-delta-without-fixer-plan.md). Every other decision of that record stays in force, and the record stays unedited beyond its Status.

Amends the base-only rule of [ADR 0197](./0197-closure-round-survives-a-base-only-merge.md) for an identical change on both parents. Every other decision of that record stays in force, and the record stays unedited beyond its Status.

## Context

PR 3350 deadlocked ([issue 3356](https://github.com/mfittko/dev-loops/issues/3356)). Its branch merged `origin/main` cleanly, and main and the PR had both changed some of the same files. The two routes that clear a cap-round head disagreed about that merge. `isBaseOnlyMergeSince` said the merge is not base-only, so `gate extend-cap-round-chain` refused with `logic_commit_in_range`. The reviewer-only delta (`reviewerOnlyBase`) found no remerge path and reported no PR-own range. The cap-round chain at the merge head could not clear, and `loop gate-coordination` returned `report_blocked` (`round_cap_reached`, `no_clearing_record`).

## Decision

A clean merge (an empty `git show --remerge-diff`) that is not base-only adds the paths that both parents changed since every merge base (`git merge-base --all`, so a criss-cross history is covered). A PR path renamed since the merge base counts by its destination when its source is in the main-side set, because the merge applies main's edit of the old path to the renamed file. Those overlap paths join the PR-own paths, so the cumulative patch holds the files where main and the PR meet. A change that both parents made identically is not an overlap of two different changes: a merge whose parents differ only by an identical change stays a base-only carry.

The refusal for a range with no PR-own commit now also requires an empty overlap: it applies only when the range has no PR-own commit, no resolution path and no overlap path. `countPrOwnCommits` counts a clean merge with a non-empty overlap as a PR-own commit.

## Consequences

`isBaseOnlyMergeSince` is shared, so the identical-change carry applies to every caller: `write-gate-context.mjs` (the clearing chain walk and `resolveCapRoundFixed`), `emit-fixer-work-order.mjs`, `extend-cap-round-chain.mjs` and `check-pre-push-delta.mjs` (`reviewerOnlyRange`, `countPrOwnCommits` and `roundAnglesOf`). A merge that resolves a PR-own file to the merged base version stays a base-only carry only when the head holds that file byte-identical to `fromHead`.

`countPrOwnCommits` counts a clean merge with a non-empty overlap as a PR-own commit. The body-only post therefore refuses with `own_commit_in_range` across an overlapping merge.
