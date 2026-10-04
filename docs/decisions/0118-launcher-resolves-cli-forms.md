# 0118. Generated CLI forms resolve through the launcher, not a pinned npx spec

## Status

Accepted — 2026-10-02 ([issue 2612](https://github.com/mfittko/dev-loops/issues/2612))

Amends [0035](./0035-consumer-entry-npm-cli-only.md): the consumer still reaches the published CLI and never a raw `node scripts/*.mjs` on a plugin checkout. The generated sanctioned form changes from `npx dev-loops@<version>` to `dev-loops-run cli/index.mjs <ns> <sub>`. The npm package stays the only runtime a consumer executes.

## Context

Inside a dev-loops checkout, `npx dev-loops@1.0.5 --version` printed `dev-loops 1.0.5-pre.1`. The root `package.json` was `dev-loops@1.0.5`, so npm treated the spec as satisfied and ran the global PATH binary. The generated forms then ran an older CLI than the checkout. That CLI did not know a newer `.devloops` key, dropped the whole `.devloops` layer, and the retrospective gate, the Copilot round cap, the mandatory angle set and the light-mode threshold changed without any error.

The generator renders one tree, `.claude/`. That tree is both the in-repo assets and the shipped plugin, so the generator cannot branch on "this is the dev-loops repository". The launcher `.claude/bin/dev-loops-run` already resolves a live source checkout first (cwd walk-up, then binary walk-up), then the plugin's installed `dev-loops` package, and otherwise exits 3. `.claude/package.json` pins that installed package to the release version.

## Decision

- `rewriteCliInvocation` renders the Pi source token `node <dev-loops-package-root>/cli/index.mjs` as `dev-loops-run cli/index.mjs`. The hook deny texts name `dev-loops-run cli/index.mjs <ns> <sub>`. The Pi source token does not change.
- Inside a dev-loops checkout the launcher resolves the checkout, so the generated form runs the checkout's code. A consumer resolves the plugin's installed package, which `.claude/package.json` pins to the release version. The consumer's version cannot drift from the plugin.
- The release runbook and the version-bump script drop the `npx dev-loops@<version>` call-site pin. The remaining release pins are the plugin manifest `version` and the `.claude/package.json` dependency pin with its lockfile entries.
- A config load error never relaxes a gate decision (`CONFIG-LOAD-FAIL-CLOSED`). This record covers the launcher half only: the loader and the per-script decisions live in the artifact authority contract.

Rejected: a repository-specific generator mode, because one tree is both the in-repo assets and the shipped plugin. Rejected: keeping the pinned `npx` form and adding a checkout check around it, because every call-site would carry the check.

## Consequences

Every generated form in a dev-loops checkout runs the checkout's CLI. A consumer runs the plugin's pinned package. The global unpinned `npm install -g dev-loops` stays a bare-shell convenience only. The release bump has one fewer surface to keep in lockstep. The new forms take effect in this repository after the PR that changes the generator merges, because the session hooks and `.claude/` load from the main checkout ([ADR 0117](./0117-self-hosting-gates-run-the-review-root-toolchain.md)).
