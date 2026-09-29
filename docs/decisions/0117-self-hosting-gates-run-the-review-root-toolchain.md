# 0117. Self-hosting gates run the review root's toolchain

## Status

Accepted — 2026-09-29 ([issue 2506](https://github.com/mfittko/dev-loops/issues/2506))

## Context

In the dev-loops repository, a PR changes the toolchain that gates it. The session hooks load from the main checkout. The gate scripts run from the checkout that `dev-loops-run` resolves from the shell cwd. Every gate step also reads its cwd for the diff, the config and the `tmp/` bundle. A PR that adds or changes a gate script, a gate config default or a hook-consumed shape therefore could not always gate itself.

The evidence is on [issue 2506](https://github.com/mfittko/dev-loops/issues/2506). On [PR 2557](https://github.com/mfittko/dev-loops/pull/2557), four self-gate attempts were lost: the main checkout's Agent hook denied a new pointer, two scripts had no root flag, the emitter resolved the diff read against its cwd, and fan-in read the main `tmp/` while reviewers wrote the worktree `tmp/`. On [PR 2496](https://github.com/mfittko/dev-loops/pull/2496), the reviewer pull resolved from the main checkout, which lacked the new script, and a `cd` preamble took the pointer over `DISPATCH_POINTER_MAX_BYTES`. On [PR 2530](https://github.com/mfittko/dev-loops/pull/2530) and [PR 2533](https://github.com/mfittko/dev-loops/pull/2533), the judge boundary refused a pull line wrapped in `cd <worktree> &&`. Folded [issue 2330](https://github.com/mfittko/dev-loops/issues/2330) ran a PR's gates with the pre-change angle set.

[ADR 0106](./0106-workers-pull-deterministic-work-orders.md) defines the work-order pull. [ADR 0107](./0107-fixer-mutation-authority-bound-to-pulled-work-order.md) and [ADR 0115](./0115-dispatch-pointer-carries-the-execution-identity-alone.md) amend it. This record amends none of them.

## Decision

- Gate scripts run the review root's toolchain. `dev-loops-run --repo-root <checkout> <script> [args...]` resolves the toolchain from `<checkout>` when it is a dev-loops source checkout and runs the script with cwd `<checkout>`. For any other directory, the toolchain order is unchanged and only the cwd follows the flag. `cd <checkout> && dev-loops-run <script>` stays valid.
- `consolidate-fanin.mjs`, `judge-pass.mjs` and `generate-claude-assets.mjs` refuse a `--repo-root` that names a dev-loops checkout other than their own toolchain root, with `toolchain_root_mismatch` and the flag-form command.
- The pull delegates. When the execution index entry sits in another dev-loops checkout that has `scripts/github/pull-work-order.mjs`, the pull re-runs that script with the same argv (a `--tmp-root` made absolute) and cwd set to that checkout. The emitter wrote the entry there, so the location is the deterministic review root. The dispatch pointer and the work-order shapes do not change. An environment marker stops a second delegation.
- The session hooks stay on the main checkout. A change to a shape that a hook or a main-checkout script consumes ships in two steps (`GATE-SELF-HOST-EXPAND-CONTRACT`), and the grill asks the self-gate question for each changed producer/consumer pair (`GRILL-SELF-HOST-PATH`).

Trust: on a self-hosting PR, the PR head's pull script writes the pull receipt. The gate already runs the PR head's emitter on such PRs, so this adds no new trust. The main-checkout hooks stay the boundary: the Agent hook checks the pointer and the judge Bash boundary checks the exact pull line.

Rejected: a per-script `--review-root` flag on seven scripts, because it repeats one fix seven times and leaves `@dev-loops/core` resolving from the shell's checkout. Rejected: loading the session hooks from the PR head, because a PR could then relax its own guards.

## Consequences

A self-hosting PR gates itself without an operator cwd exception. A PR that changes the shipped angle set dispatches the changed set on its own gates. A hook-consumed shape change needs two PRs. Consumer repos keep the installed toolchain, and the pull never delegates to a non-dev-loops checkout. The launcher is a main-checkout consumer, so its flag is live only after the PR that adds it merges.
