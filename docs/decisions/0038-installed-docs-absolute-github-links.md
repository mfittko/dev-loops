# 0038. Reference shared contract docs from installed plugin skills via absolute github.com links

## Status

Superseded by [0039](0039-bundle-shared-docs-into-plugin.md)

## Context

The installed-layout link guard introduced for the plugin surfaced a whole class of dead links: bundled `.claude/**` content referenced repo-root `docs/*.md` contracts with relative links that resolve in the source tree but escape the installed plugin root, where repo-root `docs/` never ships ([issue 1381](https://github.com/mfittko/dev-loops/issues/1381)). Known instances included the generated `agents/review` link to the gate-review sub-loop contract and roughly ten bundled `skills/docs/**` "See also" links, and the guard did not yet scan `.claude/skills/**`, so the class could silently grow. The issue framed two uniform policies to choose between: bundle the referenced docs into the plugin, or rewrite the escaping links as absolute `https://github.com/…/blob/main/docs/…` URLs and teach the guard to treat absolute URLs as intentionally external. A scheme was needed that resolved from any install location, not just a repo checkout.

## Decision

Rewrite the installed skills' doc references as absolute github.com URLs into this repository, so every link resolves identically regardless of install layout. This makes each escaping relative link a `https://github.com/mfittko/dev-loops/blob/main/docs/…` URL and extends the installed-layout guard to scan `.claude/skills/**`, treating absolute URLs as intentionally external rather than as escapes. We set aside the bundling alternative — relocating the referenced contract docs into `skills/docs/` so the generator ships them inside the plugin — despite an existing precedent that had already bundled the UI-review recipe contract that way. The URL scheme couples every installed consumer to the repository's public availability, its branch layout, and network access at read time, and it lets installed skills silently drift from the doc text they were written against, since the links always point at the current default branch rather than the shipped plugin version.

## Consequences

The scheme was rejected at an operator policy checkpoint during the same issue as unwanted external coupling — version skew against the installed plugin, coupling to the repo and branch, and a network dependency for what should be self-contained docs — and never merged. The work was redone by relocating the referenced contract docs into the plugin bundle and repointing every reference to relative forms that resolve in both the source tree and the generated layout, recorded in the superseding record. The episode also produced a standing practice: policy-level design choices such as link schemes and external coupling are surfaced to the operator before building, because the gate validates execution, not policy.
