# 0093. Run the post-merge steps from the merge wrapper and key worktree cleanup on the merged branch

## Status

Accepted — 2026-09-24 ([PR 2440](https://github.com/mfittko/dev-loops/pull/2440))

Amends [0014](./0014-managed-worktree-isolation.md): its clause that `cleanup-worktree.mjs` resolves paths through `resolveWorktreePath` from the issue or PR number. It keeps the rest of that decision unchanged. The namespace-only removal safety of 0014 and [0067](./0067-worktree-isolation-core-invariant-not-path-prefix.md) is unchanged: cleanup never removes a path outside `tmp/worktrees/dev-loops/`.

## Context

The Claude and Pi post-merge hooks run three best-effort steps after a merge: the main-checkout fast-forward, the worktree cleanup, and `postMerge.actions`. Both hooks trigger on `isMergeCapableCommand`, which matches a raw `gh pr merge` or a `git merge`. The sanctioned merge is `scripts/github/merge-pr.mjs`, and a raw `gh pr merge` is forbidden. So after a sanctioned merge none of the steps ran.

The cleanup also used the wrong key. It resolved `tmp/worktrees/dev-loops/pr-<n>`, but the loop provisions `issue-<n>`, and a variant branch can live in a differently named worktree. The hook commands also guard on `<mainCheckout>/scripts/loop/<script>`, which a consumer checkout does not have. Per-issue worktrees accumulated in both this repo and consumer checkouts.

A pruned worktree must not take merge-relevant evidence with it. The gate findings-log ledger defaults to the main checkout's `tmp/`, but an explicit `--tmp-root` could still pin it inside a linked worktree.

## Decision

`merge-pr.mjs` runs the three post-merge steps itself, after its MERGED postcondition passes, in the hooks' order: `syncMainCheckout` on the main checkout, `cleanupWorktree` keyed on the merged PR's `headRefName`, and `run-post-merge-actions.mjs` resolved from the wrapper's own package location. The main checkout comes from `resolveMainWorktreeRoot`. Each step is fail-soft and independent. No step changes `ok`, `merged`, or the exit code. The JSON result reports each step under `postMerge`.

`cleanup-worktree.mjs` gains a `--branch <name>` selector. It reads `git worktree list --porcelain` from the main checkout and selects the linked worktree under `tmp/worktrees/dev-loops/` that has the branch checked out. The main checkout is never a candidate. No match is a skip with a stated reason.

`cleanupWorktree` skips a target that holds any file under `<target>/tmp/gate-findings/`, for every selector. `write-gate-findings-log.mjs` refuses a `--tmp-root` inside a linked worktree and names the main-anchored default.

The raw `gh pr merge` hook path stays as is. The merge wrapper's command does not match `isMergeCapableCommand`, so no step runs twice.

We rejected a `postMerge.actions` entry for cleanup: actions run verbatim with no PR interpolation, so an action cannot target the merged cycle. We rejected widening `isMergeCapableCommand` to the wrapper: the hooks' script-path guard would still no-op in consumer checkouts, and the PR-number key would still miss `issue-<n>` worktrees.

## Consequences

Every sanctioned merge fast-forwards the main checkout, removes the merged branch's loop worktree, and runs `postMerge.actions`, in this repo and in consumer checkouts. Tests that drive `mergePr` to a successful merge must inject the post-merge steps through `runtime.postMergeSteps`, or the real steps run against the test checkout. A worktree that holds gate ledgers stays until the ledgers move. The pre-existing backlog of orphaned worktrees still needs a one-time manual sweep.

Four checks bound the removal. The selected worktree's HEAD must equal the merged head SHA, so unpushed local commits and a foreign checkout of the same branch name survive. The selected worktree must have a clean `git status --porcelain`, so uncommitted tracked edits and untracked non-ignored files survive; gitignored content such as `tmp/` does not block the removal, and a failed status call skips. The main checkout's `origin` must name the `--repo` slug, or no post-merge step runs. The cleanup skips a worktree that contains the merge process's cwd or the wrapper's own script file. The automated `--branch` removal runs `git worktree remove` without `--force`, so git refuses a dirty, untracked or locked worktree even when the status pre-check misses it; that refusal is a fail-soft skip and deletes nothing. `verify-fixer-disposition.mjs` now writes its checkpoint under the main-anchored tmp root. Worktrees that already hold a `fixer-disposition-*.json` under `tmp/gate-findings/` stay until the manual sweep removes them; that sweep is a non-goal of this decision. The detector reads the main-anchored checkpoint first and falls back to a checkpoint an in-flight PR wrote in its linked worktree, so that boundary still holds for that head.
