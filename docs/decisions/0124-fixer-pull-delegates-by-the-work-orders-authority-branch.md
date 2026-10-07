# 0124. A fixer pull delegates to the worktree on the work order's authority branch

## Status

Accepted — 2026-10-07 ([issue 2581](https://github.com/mfittko/dev-loops/issues/2581))

## Context

Amends [0117](./0117-self-hosting-gates-run-the-review-root-toolchain.md): the pull still delegates for a linked-worktree index entry and never delegates to the main checkout. A second delegation criterion covers the fixer. Record 0117 stays unedited.

The fixer index entry is main-anchored, so its location names no review root and the main checkout's toolchain served every fixer pull. A unit that changes the fixer work-order text emits its order with its own worktree scripts. The main checkout rebuilds the old text and refuses with `local_materialization_integrity_failure`. The reverse skew also occurs: a worktree that predates a renderer change on main emits an order that the main checkout refuses. Evidence is on issue 2581 (PRs 2580, 2576 and 2674). The pull succeeds from the worktree, but the fixer pull boundary hook ([0107](./0107-fixer-mutation-authority-bound-to-pulled-work-order.md)) denies the `--repo-root <worktree>` form.

## Decision

- A fixer pull whose execution index entry sits in the main checkout reads the digest-pinned fixer emit plan and takes its `mutationAuthority.branch`. When a linked worktree of the same repository has that branch checked out and is a dev-loops source checkout with `scripts/github/pull-work-order.mjs`, the pull re-runs that worktree's script under the existing delegation rules (same argv, absolute `--tmp-root`, environment marker).
- When no linked worktree checks out the branch, or the matching worktree is not a dev-loops source checkout, the pull stays local.
- When the delegated fixer pull exits 1 with `local_materialization_integrity_failure`, the pull retries locally once under the same digest check. This covers an order emitted from the main checkout whose renderer differs from the worktree's. The emit plan shape does not change.
- The child runs with cwd set to the worktree. Its receipt root still resolves to the main checkout's `tmp/`, so the receipt lands where the ADR 0107 grant reads it, and the grant binding to the pulling `agent_id` is unchanged.
- The fixer pull boundary hook, the emit format, the work-order digest and the gate pull delegation do not change.

Trust: the digest check runs in the delegated script against the same pinned digest. The branch comes from the emit plan that the digest-pinned work order was written from, and the branch must be a linked worktree of the same repository.

## Consequences

A self-hosting unit that changes the fixer order text, or whose worktree lags main, pulls its own fixer order. A consumer repo worktree has no pull script and pulls locally. The branch lookup runs one `git worktree list`.
