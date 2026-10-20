# 0169. UI review installs from the present lockfile, stops on boot exit, and never writes a silent null axe.json

## Status

Accepted — 2026-10-20 ([issue 2855](https://github.com/mfittko/dev-loops/issues/2855))

Amends [0028](./0028-ui-review-first-class-route.md) for the `axe.json` evidence shape only: `axe.json` holds results or an explicit skip record and is never a silent null. The record 0028 stays unedited.

## Context

The `ui_review` route provisions a worktree, boots the project, drives flows and reports. Four defects surfaced in practice. Provision assumed one package manager and skipped the install on a worktree without `node_modules`. A boot command that exited early left the readiness poll waiting until its timeout, with the output lost. `axe.json` was written as `null` when `@axe-core/playwright` was not found, which looked like a clean accessibility run. The report did not embed a screenshot for each named state.

## Decision

- Provision derives the frozen install from the lockfile present. The first match in this order wins: `bun.lock`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`. Provision also installs when the worktree has no `node_modules`.
- Boot output goes to `<tmpdir>/dev-loops-ui-review-pr-<n>-XXXXXX/boot.log`. The readiness poll stops at once when the boot process exits, including exit code 0, and reports the exit code and the output tail. `uiReview.run.command` therefore must stay in the foreground.
- `axe.json` holds either the axe results or `{skipped:true, reason}`. It is never a silent null. `@axe-core/playwright` resolves from the reviewed worktree first, then from the dev-loops install.
- The report embeds one screenshot per named state, within the existing data-URI size cap.

## Consequences

A missing lockfile manager, a missing install, an early boot exit and a missing axe package each produce a visible, diagnosable result. Recipes that daemonize their boot command must run it in the foreground. Consumers of `axe.json` must handle the skip shape.
