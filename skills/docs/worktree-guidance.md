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
this lifecycle entrypoint. It resolves the canonical namespaced path, best-effort
runs `git fetch --prune` for every candidate remote (see branch resolution below —
the one `--base` names, then `origin` when it differs; run on the create path
AND on an already-existing-worktree reuse ON A LOCAL BRANCH, so a divergence
report answers from freshly-fetched refs rather than whatever was last
fetched — a DETACHED reuse, see below, fetches nothing and skips straight to
provisioning, by design: there is no local branch there to fetch for),
creates the worktree if absent (or reuses it if one already exists at that
exact path — idempotent; a different branch at the path is reported as a
conflict rather than clobbered), then provisions it (below) in the same step:

```sh
node scripts/loop/ensure-worktree.mjs --repo-root <p> (--issue <n> | --pr <n>) \
  [--branch <name>] [--base <ref, default the repo's auto-detected default branch>]
```

Branch resolution on the create path is three-way, reported via `branchOrigin`:
an existing local branch is re-attached (`reused-local`); otherwise the first
candidate remote — in priority order, the one `--base` names, then `origin`
when it differs, so an existing `origin/<branch>` is never invisible just
because `--base` pointed at a different remote (a fork workflow's `--base
upstream/main`) — that already has a same-name branch is checked out as a new
local branch tracking that remote's tip (`tracked-remote` — upstream is the
remote branch, never base); otherwise the branch is created off the resolved
base (`created-from-base`). Reusing an already-existing worktree that is
DETACHED (no local branch — e.g. `ui-review`'s pinned-PR-head worktrees)
reports `branchOrigin: "reused-detached"` instead of fabricating a branch
association. When a local branch and a candidate remote's same-name branch
have genuinely forked, the result carries a `diverged: { remoteRef, local,
remote }` report (on both the create and reuse paths) instead of silently
picking a side; a `--single-branch` clone only carries remote-tracking refs
for the branches it was cloned with, so a genuinely existing but
never-fetched remote branch can still fall through to `created-from-base`
there.

It prints `{ ok, path, created|reused, base?, branchOrigin, diverged?,
fetchDegraded?, provision: { actions, summary }, guard }` (`base` only on
create; `provision` is the full `provisionWorktree()` result, not just its
summary; `fetchDegraded: true` means at least one candidate remote's
best-effort fetch failed, so branch resolution ran against whatever was
already fetched). Provisioning is fail-soft (a warning never aborts the
worktree); a `git worktree add` failure is a hard error. It does **not** run
`npm install` (see dependencies below).

`guard` is the default-branch guard's install result for the primary checkout
(`{ ok, installed, refreshed, skipped, defaultBranches?, droppedExplicitBranches?, reason? }`), always
present on both the create and reuse paths — installing it is best-effort and
never fails the worktree. `guard.ok: false` means the install refused
entirely (nothing was written) — see [Default-branch guard](#default-branch-guard)
below for the refusal and no-op paths, which are not all `ok: false`.

### Auto-provisioning (`.devloops` `worktree` section)

`ensure-worktree.mjs` invokes this automatically; `provision-worktree.mjs` is
available standalone for re-provisioning an existing worktree.

A fresh worktree contains only tracked files, so gitignored runtime files the
app/tests need (a config file, a large read-only dataset) are absent. Configure
which ones to bring in from the main checkout:

```yaml
# .devloops
worktree:
  entries:
    - path: config/app.yml           # mutable → copied (isolated per worktree)
      mode: copy
    - path: .env.test
      mode: copy
    - path: 'config/*.local.yml'     # glob patterns supported
      mode: copy
    - path: data/large-dataset       # large/read-only → symlinked (no duplication)
      mode: link
```

- Entries are `{ path, mode }`; `path` is a repo-relative **literal path or glob
  pattern** (native `fsp.glob`) — a directory (literal or matched) recurses.
- `mode: copy` → `fs.cp` (recursive), isolated per worktree — use for files a run
  may write to. `mode: link` → **absolute** symlink into the main checkout, shared
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

### Default-branch guard

<!-- rule: WORKTREE-DEFAULT-BRANCH-GUARD -->
`WORKTREE-DEFAULT-BRANCH-GUARD`: `ensure-worktree.mjs` also best-effort
installs `pre-commit`/`pre-merge-commit`/`pre-push` hooks into the primary
checkout's shared common hook directory, refusing a commit (plain or via
`git merge`, which git runs `pre-merge-commit` for, not `pre-commit`) on a
guarded branch, or a push to one (including via an explicit refspec such as
`HEAD:main` from a feature branch). The hooks guard the repo's OWN default
branch (git's advertised
`origin/HEAD`) — resolved fresh on every install from `origin` specifically, never from a --base guess
— and, additionally, an EXPLICIT `--base` (an operator's flag, or the
`.devloops` `workflow.baseBranch` the resolver injects as one) when it
differs: a worktree stacked on a non-default base never strips protection
from the real default. Linked worktrees run the same hooks — git resolves
them from the common directory — but a worktree's own branch is normally
neither guarded name, so its work passes through untouched. Override for a
sanctioned release or reconcile with `DEVLOOPS_ALLOW_MAIN=1 <command>`.

This is **not an unconditional guarantee** — several paths leave one or both
hooks unable to fire, each reported in the `guard` result rather than failing
the worktree. Refused entirely (`guard.ok: false`, nothing written):

- `core.hooksPath` is already configured to point elsewhere: installing into
  `$GIT_DIR/hooks` would never run.
- The resolved DEFAULT branch name is not shell-safe (contains a character
  the generated hook's own shell would expand). An unsafe EXPLICIT base does
  not refuse the install: it is dropped (reported in
  `droppedExplicitBranches` with a `reason`) and the default guard installs
  without it.
- `gitDir` does not resolve to a real git directory, or the installer itself
  fails (e.g. `git` unavailable, `repoRoot` not a git checkout).

Installed but with reduced coverage (`guard.ok: true`):

- A pre-existing hook (from another tool, or hand-authored) already occupies
  one of the guarded slots: that hook is never clobbered, and the slot is
  reported `skipped` — a guarded branch is unenforced for that hook.
- Neither the repo's own default nor an explicit base resolves to a real
  remote-tracking ref (`refs/remotes/<remote>/<branch>`) at install time
  (offline, no remote, or a base that has never been pushed): the hooks
  install inert (`guard.defaultBranches: []`) rather than guess a branch to
  protect.
- `git rebase` replays commits without running `pre-commit`/`pre-merge-commit`
  at all (git's own rebase behavior, not something an installed hook can
  change) — a rebase that moves a guarded branch is not caught by this guard.

Because of these, `ensure-worktree.mjs`'s hook is a defense-in-depth
best-effort measure, not a substitute for `WORKTREE-CREATE-PROVISION` and
`WORKTREE-DEFAULT-USE`'s own mandate to address git operations explicitly
(below).

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

A shell's working directory can reset to the primary checkout **silently** —
after a subprocess run, or when a `cd` inside a compound command does not
persist into the next one. A relative-path `git add && git commit && git
push` that runs after such a reset executes in the primary checkout on the
default branch, landing the change straight on the remote and skipping the PR
flow. Every mutating git command (`add`, `commit`, `push`, and any command
that reads or writes files) MUST address the tree explicitly rather than rely
on cwd: `git -C <absolute-worktree-path> ...` for git, and absolute paths for
test/build commands. The [default-branch guard](#default-branch-guard) above
is defense-in-depth for exactly this slip, not a substitute for it — the
guard has documented no-op paths; addressing the tree explicitly does not.

## Create or reuse flow

**Default:** run `ensure-worktree.mjs` (`WORKTREE-CREATE-PROVISION`, above),
then do the local editing, validation, commit, and PR follow-up work from that
worktree:

```sh
node scripts/loop/ensure-worktree.mjs --repo-root <p> --issue <n>
```

**Underlying mechanism** (use directly only when the entrypoint is
unavailable): `git fetch --prune origin` (and any other remote `--base`
names), check `git worktree list`, then pick ONE of the three branch
resolutions the entrypoint automates (see `branchOrigin` above) — an existing
local branch: `git worktree add tmp/worktrees/dev-loops/<kind>-<number>
<branch>`; an existing same-name remote branch on any candidate remote:
`git worktree add -b <branch> --track tmp/worktrees/dev-loops/<kind>-<number>
<remote>/<branch>`; neither: `git worktree add -b <branch>
tmp/worktrees/dev-loops/<kind>-<number> origin/main`. Unconditionally forking
off base (the last case) when a same-name branch already exists on a remote
silently drops that branch's commits and points upstream at base instead —
the exact hazard `branchOrigin: tracked-remote` exists to avoid.

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

## Never `git stash` in a shared-`.git` layout

<!-- rule: WORKTREE-NO-STASH -->
`WORKTREE-NO-STASH`: Agents MUST NOT run `git stash` (or `git stash pop`/`apply`) in this repo.
`refs/stash` is a single ref shared by every worktree over this repo's one `.git` directory, so a
stash pushed from one worktree can pop into a different worktree — parallel agents have already
picked up each other's stashed files this way. Inspect working-tree changes with `git diff` (or
`git diff --staged`) instead; save them to a patch file (`git diff > patch.diff`, later `git apply
patch.diff`) if they need to survive a checkout, or use a separate scratch worktree/checkout
rather than stashing. The Claude Code PreToolUse Bash gate blocks `git stash` outright on this
repo — including behind an env-assignment, a `command`/`env`/`exec` wrapper, a path to the `git`
binary, or leading git global options (`-C`, `-c`, `--git-dir=`, `--work-tree=`) between `git` and
`stash`.

## Fallback when worktrees are unavailable

<!-- rule: WORKTREE-FALLBACK -->
`WORKTREE-FALLBACK`: If `git worktree` is unavailable or the local environment
cannot create a worktree, the agent MUST say so explicitly and MUST use a
dedicated branch in the current checkout instead of failing closed — an
exception path that MUST NOT become the normal default for mutating local work.

## Non-goals

- No Windows symlink support (a `mode: link` entry assumes POSIX).
- No default provisioning file list — provisioning is opt-in per repo.
- Not a `node_modules` mirroring mechanism — deps belong to `npm ci`-in-worktree.
- No expansion of this guidance into a second backlog or planning system.
