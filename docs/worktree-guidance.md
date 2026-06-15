# Worktree usage guidance

## Purpose and scope

This document is the canonical repo-level owner for local worktree usage guidance in
`dev-loops`.

Use it to keep local mutation work isolated, predictable, and easy to clean up.
This guidance covers where worktrees live, when to create or reuse them, how to
handle dependencies inside them, and how to clean them up after the work is done.
It does not add new automation.

## Canonical location and naming

- Create local worktrees under `tmp/worktrees/<issue-or-branch-slug>/`.
- Prefer a stable slug derived from the active issue or branch, such as
  `issue-374-worktree-guidance`.
- Treat this as the canonical location for repo-local worktrees.
- Deprecate ad hoc locations such as `tmp/copilot-loop/`, repo-root `worktrees/`,
  and `/private/tmp/...` for normal repository worktree usage.

## Default rule: use a worktree for mutating local work

- Do not use the main checkout as the default mutation surface.
- Reserve the main checkout for inspection, control, and lightweight status checks.
- For non-trivial local edits, PR follow-up, or delegated/parallel work, create or
  reuse a dedicated git worktree first.
- The default creation flow should start from `origin/main`.

## Create or reuse flow

1. **Always fetch first:** `git fetch origin` before creating or reusing any worktree.
   Never create a worktree from a stale local `origin/main` reference.
2. Before creating anything, run `git worktree list`.
2. Reuse an existing matching branch/worktree when the path and branch already fit
   the task.
3. When no matching worktree exists, create one in the canonical location, for
   example:

   ```sh
   git worktree add -b <branch> tmp/worktrees/<issue-or-branch-slug> origin/main
   ```

4. Do the local editing, validation, commit, and PR follow-up work from that
   worktree rather than from the main checkout.

## Dependency and install expectations

- If the worktree needs dependencies, or its installed state is stale, run
  `npm install` or `npm ci` inside the worktree.
- Do not assume the main checkout's `node_modules` are present or valid for a
  separate worktree.
- Re-run worktree-local installs when the dependency state is missing or clearly
  out of date for the branch you are working on.

## Coordination and collision checks

- Always check `git worktree list` before creating a new worktree.
- Reuse an existing matching worktree when practical instead of creating a second
  path for the same branch.
- Avoid branch-name and filesystem-path collisions by checking both branch intent
  and target path before `git worktree add`.
- When multiple agents or operators may touch the same issue, record which branch
  and worktree path are already in use before starting new mutation work.

## Cleanup and prune flow

- After a PR is merged or the work is abandoned, remove the worktree with:

  ```sh
  git worktree remove --force <path>
  ```

- After removal, run:

  ```sh
  git worktree prune
  ```

- Cleanup should happen promptly after merge so stale worktrees do not accumulate
  under `tmp/worktrees/`.

## Fallback when worktrees are unavailable

- If `git worktree` is unavailable or the local environment cannot create a
  worktree, say so explicitly.
- In that fallback case, use a dedicated branch in the current checkout instead of
  failing closed.
- Even in fallback mode, treat the current checkout as an exception path rather
  than the normal default for mutating local work.

## Non-goals

- No new worktree automation scripts.
- No runtime behavior changes to loop helpers.
- No expansion of this guidance into a second backlog or planning system.
