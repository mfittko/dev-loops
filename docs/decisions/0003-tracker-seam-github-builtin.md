# 0003. Tracker seam with GitHub built in; external trackers are post-1.0 plugins

## Status

Accepted

## Context

The original tracker-first hybrid vision wanted Jira/Shortcut as a source of truth integrated before 1.0. Building bespoke integrations for external trackers would have blocked the 1.0 cut on third-party API surfaces the loop does not control ([issue 1408](https://github.com/mfittko/dev-loops/issues/1408)).

## Decision

We cut a generic `Tracker` seam: a provider interface plus registry in `packages/core/src/tracker/`, with GitHub as the built-in default adapter, and renamed the `github-first` strategy to the provider-neutral `tracker-first` (deprecated alias retained with a load-time warning). External trackers become post-1.0 drop-in providers behind the same seam ([issue 1418](https://github.com/mfittko/dev-loops/issues/1418) tracks completion). Rejected alternative: shipping a bespoke Jira/Shortcut integration pre-1.0 (blocks the release on external surfaces and duplicates the seam later anyway).

## Consequences

1.0 ships tracker-agnostic in name and shape while only the GitHub provider exists, and external-tracker support becomes an additive plugin rather than a core rewrite. Remaining direct GitHub call sites must migrate behind the seam as follow-up work.
