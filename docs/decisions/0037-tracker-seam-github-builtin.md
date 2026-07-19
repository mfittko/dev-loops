# 0037. Cut a generic tracker seam with GitHub built in; defer external trackers to post-1.0 plugins

## Status

Accepted — 2026-07-18 ([PR 1417](https://github.com/mfittko/dev-loops/pull/1417))

## Context

Every issue and board operation was hard-wired to `gh`-command construction scattered across thin scripts under `scripts/github/` and `scripts/projects/`, so the loop could not run against any non-GitHub tracker without rewriting core call sites. The original hybrid vision wanted Jira/Shortcut integrated before 1.0, which would have blocked the release on third-party API surfaces the loop does not control. The RFC at [issue 1408](https://github.com/mfittko/dev-loops/issues/1408) proposed a tracker-agnostic seam instead, landed via [PR 1417](https://github.com/mfittko/dev-loops/pull/1417) with remaining call-site migration tracked in [issue 1418](https://github.com/mfittko/dev-loops/issues/1418); the earlier [PR 1403](https://github.com/mfittko/dev-loops/pull/1403) had already closed out the deferred tracker-first routing scope. The canonical contract is `skills/docs/tracker-seam-contract.md`, implemented in `packages/core/src/tracker/` over `packages/core/src/github/issue-ops.mjs`.

## Decision

We cut a generic `Tracker` seam that mirrors the existing harness-adapter idiom: a provider interface plus registry in `packages/core/src/tracker/`, where `createTrackerAdapter` validates and freezes the required Issues capability (`parseRef`, `getIssue`, `createIssue`, `editIssue`, `commentIssue`, `listIssues`, `detectLinkedPr`) and `hasBoardCapability` separately checks the optional Board capability. `createGithubTrackerAdapter` ships as the built-in default provider, a facade over `gh` issue operations extracted from the thin CLI scripts into core so both paths call one implementation. The seam deliberately excludes the PR/VCS-host surface — Copilot review, gate tooling, and the PR lifecycle stay GitHub-coupled as a future, orthogonal seam — and we renamed the `github-first` strategy to the provider-neutral `tracker-first`, keeping the old name as a deprecated alias normalized at config load. External trackers become post-1.0 drop-in providers registered through `resolveTrackerAdapter`, which takes the effective config as a plain parameter and holds no singleton state. We rejected a bespoke pre-1.0 Jira/Shortcut integration: it would have coupled the 1.0 release to external API surfaces for providers no consumer had yet asked to run.

## Consequences

1.0 ships tracker-agnostic in name and shape while only the GitHub provider exists, and adding an external tracker is an additive plugin against the frozen interface rather than a core rewrite. The Issues-required/Board-optional capability split is the contract future providers implement against, and it leaves room for a later composite adapter that delegates issues and board to different providers. The built-in GitHub adapter only partially wires the Board capability — two board primitives are routed through core while the remaining board writers stay on their direct CLI path, so `hasBoardCapability` reports false for it — and remaining direct GitHub call sites must migrate behind the seam as follow-up work. Until that migration lands, the seam's guarantee is structural rather than total: the interface is stable, but not every caller routes through it yet.
