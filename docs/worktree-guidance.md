# Worktree usage guidance

Canonical owner for local worktree usage guidance in `dev-loops`.

## Purpose and scope

Use it to keep local mutation work isolated, predictable, and easy to clean up.
This guidance covers where worktrees live, how to create-or-reuse and provision
them in one step (`ensure-worktree.mjs`), how to handle dependencies inside them,
and how loop-owned worktrees are cleaned up after merge (`cleanup-worktree.mjs`).
The raw `git worktree` commands remain documented as the underlying mechanism.

## Canonical location and naming

<!-- rule: WORKTREE-CANONICAL-PATH -->
`WORKTREE-CANONICAL-PATH`: Loop-owned worktrees MUST live at the namespaced path
`tmp/worktrees/dev-loops/<kind>-<number>` — e.g. `tmp/worktrees/dev-loops/issue-909`,
`tmp/worktrees/dev-loops/pr-908` — with **no branch suffix**, so the path is
recomputable from the issue/PR number alone. `resolveWorktreePath({ repoRoot, kind,
number })` in `packages/core/src/loop/handoff-envelope.mjs` is the sole resolver for
create, provision, and cleanup.

- The `dev-loops/` namespace marks loop-owned worktrees so cleanup can only ever
  remove its own — a hand-made `tmp/worktrees/my-experiment` is never touched.
- Deprecate ad hoc locations such as `tmp/copilot-loop/`, repo-root `worktrees/`,
  and `/private/tmp/...` for normal repository worktree usage.

## Lifecycle automation

The worktree lifecycle is owned end to end: **create + provision** in one
command → **post-merge cleanup**. The two entrypoints below are the DEFAULT
path; the raw `git worktree add` / `git worktree remove` commands are the
underlying mechanism, not the operator interface.

### Create (or reuse) + provision: `ensure-worktree.mjs`

<!-- rule: WORKTREE-CREATE-PROVISION -->
`WORKTREE-CREATE-PROVISION`: Creating or reusing a loop-owned worktree MUST use
this lifecycle entrypoint. It resolves the canonical namespaced path, `git
fetch`es the base remote, creates the worktree if absent (or reuses it if one
already exists at that exact path — idempotent; a different branch at the path
is reported as a conflict rather than clobbered), then provisions it (below) in
the same step:

```sh
node scripts/loop/ensure-worktree.mjs --repo-root <p> (--issue <n> | --pr <n>) \
  [--branch <name>] [--base <ref, default origin/main>]
```

It prints `{ ok, path, created|reused, provision: { actions, summary } }` (the
full `provisionWorktree()` result, not just its summary). Provisioning is
fail-soft (a warning never aborts the worktree); a `git worktree add` failure is
a hard error. It does **not** run `npm install` (see dependencies below).

### Auto-provisioning (`.devloops` `worktree` section)

`ensure-worktree.mjs` invokes this automatically; `provision-worktree.mjs` is
available standalone for re-provisioning an existing worktree.

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

<!-- rule: WORKTREE-CLEANUP -->
`WORKTREE-CLEANUP`: After a successful merge, the canonical worktree MUST be
removed via this entrypoint, which resolves the path through the shared
resolver, runs `git worktree remove --force` + `git worktree prune` from the
main checkout, and MUST NOT touch any path outside `tmp/worktrees/dev-loops/`:

```sh
node scripts/loop/cleanup-worktree.mjs --repo-root <p> (--issue <n> | --pr <n> | --path <p>)
```

Git errors are logged but never fatal, so cleanup can't break a
merge-completion flow.

## Default rule: use a worktree for mutating local work

<!-- rule: WORKTREE-DEFAULT-USE -->
`WORKTREE-DEFAULT-USE`: Non-trivial local edits, PR follow-up, or
delegated/parallel work MUST use a dedicated git worktree, not the main
checkout. The default base is `origin/main` (the tooling fetches it first,
best-effort, and honors an explicit `--base` override). The main checkout is
reserved for inspection, control, and lightweight status checks.

## Create or reuse flow

**Default:** run `ensure-worktree.mjs` (`WORKTREE-CREATE-PROVISION`, above),
then do the local editing, validation, commit, and PR follow-up work from that
worktree:

```sh
node scripts/loop/ensure-worktree.mjs --repo-root <p> --issue <n>
```

**Underlying mechanism** (use directly only when the entrypoint is
unavailable): `git fetch origin`, check `git worktree list`, then
`git worktree add -b <branch> tmp/worktrees/dev-loops/<kind>-<number> origin/main`.

## Dependency and install expectations

<!-- rule: WORKTREE-DEPS-ISOLATED -->
`WORKTREE-DEPS-ISOLATED`: A worktree's dependencies MUST NOT be assumed present
or valid from the main checkout's `node_modules`; run `npm install` or `npm ci`
inside the worktree whenever it needs dependencies or its installed state is
stale or out of date for the branch.

## Coordination and collision checks

<!-- rule: WORKTREE-DEDUPE -->
`WORKTREE-DEDUPE`: Before creating a worktree, an agent MUST check `git worktree
list` for an existing entry at the target branch/path, and SHOULD reuse a
matching existing worktree instead of creating a second path for the same
branch when practical.

- Avoid branch-name and filesystem-path collisions by checking both branch intent
  and target path before `git worktree add`.
- When multiple agents or operators may touch the same issue, record which branch
  and worktree path are already in use before starting new mutation work.

## Cleanup and prune flow

**Default:** after a PR is merged (or the work is abandoned), run
`cleanup-worktree.mjs` (`WORKTREE-CLEANUP`, see [Post-merge cleanup](#post-merge-cleanup)
above):

```sh
node scripts/loop/cleanup-worktree.mjs --repo-root <p> (--issue <n> | --pr <n>)
```

Clean up promptly after merge so stale worktrees do not accumulate under
`tmp/worktrees/`.

## Fallback when worktrees are unavailable

<!-- rule: WORKTREE-FALLBACK -->
`WORKTREE-FALLBACK`: If `git worktree` is unavailable or the local environment
cannot create a worktree, the agent MUST say so explicitly and MUST use a
dedicated branch in the current checkout instead of failing closed — an
exception path that MUST NOT become the normal default for mutating local work.

## Non-goals

- No Windows symlink support (`linkOnInit` assumes POSIX).
- No default provisioning file list — provisioning is opt-in per repo.
- Not a `node_modules` mirroring mechanism — deps belong to `npm ci`-in-worktree.
- No expansion of this guidance into a second backlog or planning system.
