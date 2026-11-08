# 0177. Hand the delta reviewer a patch artifact and a read-only evidence rule

## Status

Accepted — 2026-10-21 ([PR 2906](https://github.com/mfittko/dev-loops/pull/2906))

Extends [0141](./0141-delta-review-changed-line-lens-and-stale-surface-check.md) and [0094](./0094-pre-push-reviewer-delta-mode.md) by reference. It amends neither.

## Context

[Issue #2854](https://github.com/mfittko/dev-loops/issues/2854) slice 2 covers the delta reviewer input. The delta reviewer is a read-only role. It must review every hunk of the cumulative `reviewBaselineHead..candidateHead` diff, but the input carried no diff, so the reviewer needed a shell to run `git diff`. The input also stated no rule for what counts as evidence or which commands the reviewer may run.

## Decision

Add the rule `PRE-PUSH-DELTA-PATCH-ARTIFACT` to `skills/docs/pre-pr-review-contract.md`, implemented in `scripts/loop/check-pre-push-delta.mjs`.

The delta input run (the run without `--result`) writes the cumulative patch to `<tmp-root>/gate-delta/<reviewBaselineHead>-<candidateHead>.patch`. It carries that path as `input.patchPath` and an `input.evidenceRule`. The `--handback` run writes nothing and prints neither field.

The reviewer reads `patchPath` with the read tool and does not run `git diff`. Evidence is a file:line, or a test's path:line, read from disk. The reviewer runs no tests, builds, or other commands that mutate or execute anything. For a site query it uses only the shell-inert read/search programs the review role gate allows (`git grep`, `grep`, `rg`). The coordinator briefs the reviewer with the input artifact paths only and still inlines no diff bytes.

## Consequences

- The delta reviewer reviews every hunk without shell access to `git diff`.
- Evidence stays reproducible from files on disk at the candidate head.
- The `--handback` run stays write-free, so the fixer's handback check leaves no artifact.
- The patch file is local evidence under the tmp root and is not tracked.
