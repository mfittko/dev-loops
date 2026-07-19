# 0001. Bundle shared contract docs into the plugin instead of linking to the repo

## Status

Accepted

## Context

Installed plugin skills referenced the shared workflow contract docs via absolute `github.com` links into this repository. That coupled every installed consumer to the repo's public availability, branch layout, and network access, and let installed skills silently drift from the docs they were written against. The operator rejected the external-link scheme at a policy checkpoint during [issue 1381](https://github.com/mfittko/dev-loops/issues/1381).

## Decision

We bundle the shared contract docs into the plugin. The repo keeps a single source of truth under `skills/docs/`, mirrored verbatim into the installed plugin layout by the asset generator, and installed skills read the bundled relative copies (`../docs/<contract>.md`) — never a remote URL. Rejected alternatives: absolute `github.com` links (external coupling, drift), and a docs-fetch step at install time (network dependence, cache invalidation complexity).

## Consequences

Installed plugins are self-contained and offline-correct, and every plugin version pins the exact contract text it shipped with. The repo pays for a generated mirror that must stay in sync (enforced by the asset generator and drift checks), and shared docs must live under `skills/docs/` to be bundled.
