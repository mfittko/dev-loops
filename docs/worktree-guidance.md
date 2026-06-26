# Worktree usage guidance

## Purpose and scope

This document is the canonical repo-level owner for local worktree usage guidance in
`dev-loops`.

Use it to keep local mutation work isolated, predictable, and easy to clean up.
This guidance covers where worktrees live, when to create or reuse them, how to
handle dependencies inside them, how loop-owned worktrees are auto-provisioned
and cleaned up, and how to clean them up manually when needed.

## Canonical location and naming

- Loop-owned worktrees live under the namespaced path
  `tmp/worktrees/dev-loops/<kind>-<number>` — e.g. `tmp/worktrees/dev-loops/issue-909`,
  `tmp/worktrees/dev-loops/pr-908`. **No branch suffix:** the path is recomputable
  from the issue/PR number alone, which is what lets cleanup find it.
- A single resolver, `resolveWorktreePath({ repoRoot, kind, number })` in
  `packages/core/src/loop/handoff-envelope.mjs`, is the sole source of truth for
  create, provision, and cleanup.
- The `dev-loops/` namespace marks loop-owned worktrees so cleanup can only ever
  remove its own — a hand-made `tmp/worktrees/my-experiment` is never touched.
- Deprecate ad hoc locations such as `tmp/copilot-loop/`, repo-root `worktrees/`,
  and `/private/tmp/...` for normal repository worktree usage.

## Lifecycle automation

The worktree lifecycle is owned end to end: namespaced naming → provisioning of
configured gitignored files → post-merge cleanup.

### Auto-provisioning (`.devloops` `worktree` section)

A fresh worktree contains only tracked files, so gitignored runtime files the
app/tests need (a config file, a large read-only dataset) are absent. Configure
which ones to bring in from the main checkout:

```yaml
# .devloops
worktree:
  copyOnInit:          # mutable → copied (isolated per worktree)
    - config/app.yml
    - .env.test
    - 'config/*.local.yml'   # glob patterns supported
  linkOnInit:          # large/read-only → symlinked (no duplication)
    - data/large-dataset
```

- Entries are repo-relative **literal paths or glob patterns** (native
  `fsp.glob`). A directory (literal or matched) recurses.
- `copyOnInit` → `fs.cp` (recursive), isolated per worktree — use for files a run
  may write to. `linkOnInit` → **absolute** symlink into the main checkout, shared
  across worktrees — use **only for read-only data** (a symlinked dir is one
  underlying directory; never link anything a run mutates).
- Sources resolve against the main checkout, never cwd. Every resolved path must
  resolve **inside** the main checkout or it is rejected with a log line
  (path-traversal guard).
- **Fail-soft:** a missing source or an empty glob logs one warning and continues
  — provisioning never aborts init. Idempotent on worktree reuse.
- **Opt-in:** empty/absent by default; no baked-in file list.
- **Not for `node_modules`.** A copied/symlinked `node_modules` goes stale the
  moment a branch changes a dependency and can break native builds — use the
  `npm ci`-in-worktree path below. Provisioning does **not** run `npm install`.

Run manually with:

```sh
node scripts/loop/provision-worktree.mjs --worktree-path <p> --repo-root <p>
```

### Post-merge cleanup

After a successful merge, the canonical worktree is removed automatically:

```sh
node scripts/loop/cleanup-worktree.mjs --repo-root <p> (--issue <n> | --pr <n> | --path <p>)
```

It resolves the canonical path via the shared resolver, runs `git worktree remove
--force` + `git worktree prune` from the main checkout, and **refuses any path not
under `tmp/worktrees/dev-loops/`**. Git errors are logged but never fatal, so
cleanup can't break a merge-completion flow.

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
   git worktree add -b <branch> tmp/worktrees/dev-loops/<kind>-<number> origin/main
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

- No Windows symlink support (`linkOnInit` assumes POSIX).
- No default provisioning file list — provisioning is opt-in per repo.
- Not a `node_modules` mirroring mechanism — deps belong to `npm ci`-in-worktree.
- No expansion of this guidance into a second backlog or planning system.
