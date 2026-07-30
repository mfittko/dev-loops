# 0044. Enforce the default-branch mandate with installed git hooks, not prose alone

## Status

Accepted — 2026-07-30 ([PR 1506](https://github.com/mfittko/dev-loops/pull/1506))

## Context

A shell's working directory can reset to the primary checkout silently — after a subprocess run, or when a `cd` inside a compound command does not persist into the next one. A relative-path `git add && git commit && git push` that runs after such a reset executes in the primary checkout on the repo's default branch, landing the change straight on the remote and skipping the PR flow entirely. `WORKTREE-DEFAULT-USE` and the pre-flight gate already mandate addressing the tree explicitly, but that mandate is prose and a fail-closed *isolation* check (worktree path, branch identity) — neither actually stops the dangerous git operation itself when the cwd assumption silently breaks. 0014 rejected doc-only mandates for worktree usage generally for the same reason: prose demonstrably failed to prevent violations.

## Decision

`ensure-worktree.mjs` best-effort installs `pre-commit`/`pre-push` hooks into the primary checkout's shared common git hook directory (identical for the main checkout and every linked worktree, since git resolves hooks from there). The hooks refuse a commit or push — including via an explicit refspec such as `HEAD:main` from a feature branch — that would land on a guarded branch. Guarded branches are the repo's own default (git's advertised `<remote>/HEAD`, resolved fresh on every install, never guessed) and, additionally, an explicit `--base` (an operator's flag, or the `.devloops` `workflow.baseBranch` the resolver injects as one) when it differs — a worktree stacked on a non-default base is protected too, without ever losing protection of the real default. Installing hooks is best-effort and fails soft (a worktree is still created even if the guard cannot install); several documented no-op paths exist (an already-configured `core.hooksPath`, a foreign pre-existing hook, or a base that cannot be resolved to a real ref). `DEVLOOPS_ALLOW_MAIN=1 <command>` is the sanctioned override for a deliberate release or reconcile commit/push to the default branch.

## Consequences

Every consumer's primary checkout now gets pre-commit/pre-push hooks written on `ensure-worktree` — a mechanical enforcement layer where only prose existed before, at the cost of an operator-facing override variable the release runbook must document and use. The guard is defense-in-depth, not a replacement for `WORKTREE-DEFAULT-USE`'s explicit-tree-addressing mandate: its no-op paths mean a consumer repo with an unusual `core.hooksPath` or a pre-existing hook is not actually protected, and that must stay visible in the guard's own result rather than a false `ok: true`. Because the hooks live in one shared, repo-wide directory rather than per-worktree state, installing must never narrow what an earlier install already protected — the repo's own default is re-derived independently of any given invocation's `--base` specifically so a later, differently-based `ensure-worktree` call cannot silently strip its protection.
