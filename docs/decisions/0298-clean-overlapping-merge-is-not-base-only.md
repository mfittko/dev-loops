# 0298. A clean overlapping merge adds its overlap paths to the PR-own paths

## Status

Accepted, 2026-11-21 ([issue 3356](https://github.com/mfittko/dev-loops/issues/3356)).

Amends decision 3 of [ADR 0255](./0255-code-range-delta-without-fixer-plan.md). Every other decision of that record stays in force, and the record stays unedited beyond its Status.

## Decision

A clean merge (an empty `git show --remerge-diff`) that is not base-only adds the paths that both parents changed since every merge base (`git merge-base --all`, so a criss-cross history is covered). Those overlap paths join the PR-own paths, so the cumulative patch holds the files where main and the PR meet. A change that both parents made identically is not an overlap of two different changes: a merge whose parents differ only by an identical change stays a base-only carry.

The refusal for a range with no PR-own commit now also requires an empty overlap: it applies only when the range has no PR-own commit, no resolution path and no overlap path. `countPrOwnCommits` counts a clean merge with a non-empty overlap as a PR-own commit.
