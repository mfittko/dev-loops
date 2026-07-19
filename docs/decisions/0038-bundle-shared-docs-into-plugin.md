# 0038. Bundle shared contract docs into the plugin instead of linking to the repo

## Status

Accepted — 2026-07-18 ([PR 1424](https://github.com/mfittko/dev-loops/pull/1424))

## Context

Installed plugin skills referenced the shared workflow contract docs via absolute `github.com` links into this repository (a scheme that was implemented but rejected at the operator checkpoint before merging). That coupled every installed consumer to the repo's public availability, branch layout, and network access, and let installed skills silently drift from the docs they were written against — links resolved to the default branch, not the contract text the installed plugin version shipped with. The operator rejected the external-link scheme at a policy checkpoint during [issue 1381](https://github.com/mfittko/dev-loops/issues/1381), and [PR 1424](https://github.com/mfittko/dev-loops/pull/1424) implemented the replacement by migrating the referenced contract docs wholesale from repo-root `docs/` into `skills/docs/`.

## Decision

We bundle the shared contract docs into the plugin. The repo keeps a single source of truth under `skills/docs/`, the asset generator mirrors it into the installed plugin layout (stripping pi-only blocks during generation), and installed skills read the bundled relative copies — never a remote URL. We rejected absolute `github.com` links (external coupling, version drift against the installed plugin) and a docs-fetch step at install time (network dependence, cache-invalidation complexity).

## Consequences

Installed plugins are self-contained and offline-correct, and every plugin version pins the exact contract text it shipped with. The repo pays for a generated mirror that must stay in sync, enforced by the asset generator and drift checks. Any shared doc a skill references must live under `skills/docs/` to be bundled, so future contract docs meant for installed consumers start there rather than in repo-root `docs/`.
