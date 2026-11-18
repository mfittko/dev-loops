# 0292. A spike PR skips the pre-creation size refusal

## Status

Accepted — 2026-11-18 ([issue 3249](https://github.com/mfittko/dev-loops/issues/3249))

Extends [0154](./0154-pr-create-refuses-oversize-before-creation.md).

## Context

Record 0154 makes `pr create` refuse at or above the default-tier `waiverLoc` with no override. A spike PR is a reference draft that never merges. Its size follows from the exploration, and a split into stacked PRs only to open it gives no review value ([issue 3249](https://github.com/mfittko/dev-loops/issues/3249)).

## Decision

`pr create --spike-file <findings.md>` skips the `size_split_required_before_pr` refusal. The flag reuses the spike findings artifact: the file must carry non-empty `Question`, `Approach` and `Findings` sections (`validateSpikeExplorationSections`), or `pr create` refuses. `pr create` stamps the marker line `<!-- dev-loops:spike-pr no-merge -->` into the PR body. `pr ready-for-review` and `merge-pr` refuse any PR whose body carries that marker, so the exemption opens no route to merging an oversize PR. `pr create` still prints the `{adrTripwire,sizeBudget}` line, so the size stays visible as advisory. Size tiers and the refusal for every other PR stay as in 0154. Rejected alternative: a `gates.spike.size` tier, which adds a knob with no acceptance row.

## Consequences

An oversize spike opens as a draft without a split. The marker lives in the PR body, so the refusal holds across sessions. Removing the marker from the body by hand lifts the refusal; `PRE-PR-SIZE-CHECK` stays the rule that names the exemption.
