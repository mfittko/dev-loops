# Worktree usage guidance

Canonical owner for local worktree usage guidance in `dev-loops`.

## Purpose and scope

Keep local mutation work isolated and easy to clean up: where worktrees live,
create-or-reuse plus provisioning (`ensure-worktree.mjs`), dependencies, and
post-merge cleanup (`cleanup-worktree.mjs`).

## Canonical location and naming

<!-- rule: WORKTREE-CANONICAL-PATH -->
`WORKTREE-CANONICAL-PATH`: Loop-owned worktrees MUST live at the namespaced path
`tmp/worktrees/dev-loops/<kind>-<number>` — e.g. `tmp/worktrees/dev-loops/issue-909`,
`tmp/worktrees/dev-loops/pr-908` — with **no branch suffix**, so the path is
recomputable from the issue/PR number alone. `resolveWorktreePath({ repoRoot, kind,
number })` in `packages/core/src/loop/handoff-envelope.mjs` is the sole resolver for
create, provision, and cleanup.

- The `dev-loops/` namespace marks loop-owned worktrees, so cleanup never
  touches a hand-made `tmp/worktrees/my-experiment`.
- Do not use ad hoc locations such as `tmp/copilot-loop/`, repo-root
  `worktrees/`, and `/private/tmp/...` for normal repository worktree usage.

## Lifecycle automation

The two entrypoints below are the DEFAULT path for **create + provision** and
**post-merge cleanup**; raw `git worktree add` / `git worktree remove` are the
underlying mechanism.

### Create (or reuse) + provision: `ensure-worktree.mjs`

<!-- rule: WORKTREE-CREATE-PROVISION -->
`WORKTREE-CREATE-PROVISION`: Creating or reusing a loop-owned worktree MUST use
this lifecycle entrypoint. It resolves the canonical namespaced path and
best-effort runs `git fetch --prune` for every candidate remote (the one
`--base` names, then `origin` when it differs) on the create path and on a
reuse ON A LOCAL BRANCH; a DETACHED reuse fetches nothing. It creates the
worktree if absent or reuses the one at that exact path (idempotent; a
different branch at the path is reported as a conflict, never clobbered), then
provisions it (below) in the same step:

```sh
node scripts/loop/ensure-worktree.mjs --repo-root <p> (--issue <n> | --pr <n>) \
  [--branch <name>] [--base <ref, default the repo's auto-detected default branch>]
```

Branch resolution on the create path is three-way, reported via `branchOrigin`:
an existing local branch is re-attached (`reused-local`); otherwise the first
candidate remote (same priority order as the fetch) that has a same-name branch
is checked out as a new local branch tracking that remote's tip
(`tracked-remote`; upstream is the remote branch, never base); otherwise the
branch is created off the resolved base (`created-from-base`). A DETACHED reuse
(e.g. `ui-review`'s pinned-PR-head worktrees) reports
`branchOrigin: "reused-detached"`. When a local branch and a candidate remote's
same-name branch have forked, the result carries a `diverged: { remoteRef,
local, remote }` report on both paths instead of picking a side. A
`--single-branch` clone lacks remote-tracking refs for other branches, so an
unfetched remote branch can still fall through to `created-from-base`.

It prints `{ ok, path, created|reused, base?, branchOrigin, diverged?,
fetchDegraded?, provision: { actions, summary }, guard }`. `base` appears only on
create; `provision` is the full `provisionWorktree()` result; `fetchDegraded: true`
means at least one candidate remote's fetch failed, so branch resolution used the
refs already present. Provisioning is fail-soft; a `git worktree add` failure is
a hard error. It does **not** install dependencies (see below).

`guard` is the default-branch guard's install result for the primary checkout
(`{ ok, installed, refreshed, skipped, defaultBranches?, droppedExplicitBranches?, reason? }`),
present on both paths. Installing it is best-effort and never fails the worktree.
`guard.ok: false` means the install refused entirely (nothing written); see
[Default-branch guard](#default-branch-guard) for the refusal and no-op paths.

### Auto-provisioning (`.devloops` `worktree` section)

`ensure-worktree.mjs` invokes this automatically; `provision-worktree.mjs` is
available standalone for re-provisioning an existing worktree.

A fresh worktree contains only tracked files. Configure which gitignored runtime
files (a config file, a large read-only dataset) to bring in from the main
checkout:

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
- **Not for `node_modules`:** use `bun install --frozen-lockfile` inside the
  worktree (`WORKTREE-DEPS-ISOLATED`).

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
branch (git's advertised `origin/HEAD`, resolved fresh on every install from
`origin`, never from a --base guess) and, additionally, an EXPLICIT `--base`
(an operator's flag, or the `.devloops` `workflow.baseBranch` the resolver
injects as one) when it differs. Linked worktrees run the same hooks, but a
worktree's own branch is normally neither guarded name. Override for a
sanctioned release or reconcile with `DEVLOOPS_ALLOW_MAIN=1 <command>`.

This is **not an unconditional guarantee**. The `guard` result reports each
path that leaves a hook unable to fire. Refused entirely (`guard.ok: false`,
nothing written):

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
- `git rebase` runs neither `pre-commit` nor `pre-merge-commit`, so a rebase
  that moves a guarded branch is not caught.

The guard is defense-in-depth, not a substitute for `WORKTREE-DEFAULT-USE`'s
mandate to address git operations explicitly (below).

### Commit-message contract guard

<!-- rule: WORKTREE-COMMIT-MSG-GUARD -->
`WORKTREE-COMMIT-MSG-GUARD`: `ensure-worktree.mjs` also best-effort installs a
`commit-msg` hook into the same common hook directory as the default-branch
guard above (reported separately, as `commitMsgGuard` in the result, since it
guards message CONTENT rather than a branch). It enforces the commit-message
contract at commit time instead of leaving it to agent discipline:

- An agent-authored commit (`CLAUDECODE=1` in the environment — a plain
  human commit is exempt, since it is never "Claude") carries
  `Co-Authored-By: Claude <model> <noreply@anthropic.com>` in every
  repository, and carries a `Claude-Session:` trailer only when the
  repository opts in (the key bullet below).
- The key `worktree.commitMsgGuard.requireClaudeSession` opts a repository in
  to the `Claude-Session:` check. Its default is `false`. The value is read
  only from the `.devloops` family (`.devloops`, `.devloops.yaml`,
  `.devloops.yml`, `.devloops.json`) at `refs/remotes/origin/<default>`, where
  `<default>` comes from `origin/HEAD`. It is never read from the working-tree
  `.devloops`, a PR head, an environment variable, git config or a CLI flag.
  The value is `true` only when that file parses and sets the literal `true`.
  The value is `false` when `origin/HEAD` or the remote-tracking ref does not
  resolve, when no `.devloops` family file exists there, or when the key is
  absent or `false`. The value is `true` with one `[ensure-worktree] WARN`
  line when the file exists but cannot be read, does not parse, or sets a
  non-boolean value, so an unreadable policy never loosens the guard.
  `ensure-worktree.mjs` bakes the value into the hook at install time and the
  hook reads nothing at commit time, so a change takes effect on the next
  `ensure-worktree.mjs` run. The `Co-Authored-By`, bare issue reference and
  subject checks stay mandatory for both values. An agent may add the key as
  `true`. An agent never sets the key to `false`, never removes it, never
  changes `origin/HEAD` or a remote-tracking ref to change the read, and never
  skips the session check with an environment variable, git config or the
  waiver line.
- A bare non-issue `#<digits>` enumeration is rejected — GitHub auto-links it
  to an unrelated issue/PR when rendered. A genuine `Closes #N` / `Fixes #N`
  / `Refs #N` reference is allowed, including its trailer colon form
  (`Closes: #N`).
- The subject must be conventional-commit form `type(scope): summary` (type
  one of `feat`/`fix`/`chore`/`docs`/`test`/`refactor`/`revert`/`perf`/
  `style`/`ci`/`build`).
- A default, unedited merge message (`Merge branch '...'`, `Merge
  remote-tracking branch '...'`, `Merge pull request #...`, `Merge tag
  '...'`), a default `git revert` message
  (`Revert "..."`), or a `git commit --fixup`/`--squash` autosquash subject
  (`fixup! ...` / `squash! ...`) is exempt — each is git/tooling-generated,
  not operator-authored prose.
- A merge commit uses git's default subject. An agent never hand-writes a
  merge subject.
- A per-commit waiver line (`dev-loops:commit-msg-guard:allow`) skips every
  check above for a deliberate exception. The waiver is operator-only: an
  agent-authored commit never carries the waiver line.

Same refusal/degraded-coverage shape as the default-branch guard (a
pre-existing `commit-msg` hook is never clobbered; `core.hooksPath` pointing
elsewhere refuses the install) — see `installCommitMsgGuard` in
`packages/core/src/loop/commit-msg-guard.mjs`.

### Wrong-checkout file-mutation guard

<!-- rule: WORKTREE-WRONG-CHECKOUT-GUARD -->
`WORKTREE-WRONG-CHECKOUT-GUARD`: under the Claude harness, the PreToolUse
`Edit`/`Write` hook (`.claude/hooks/pre-tool-use-write-guard.mjs`, deciding via
`decideWorktreeCheckoutGuard`) refuses a file mutation that would land on the
MAIN checkout while a worktree cycle is active. The "active worktree" is the
one CONTAINING the call context's `cwd`. A write is refused when cwd sits inside
a listed worktree and the target resolves to a non-gitignored file in the main
checkout (`git check-ignore`, so a new untracked source file is caught too); the
refusal names the worktree-local path to use instead. This guard is ALWAYS ON:
it runs in-process on every `Edit`/`Write` and needs no hook install. It is the
tool-call-time counterpart to the commit-time
`pre-commit-branch-guard.mjs --block-main-checkout` check.

- A legitimate in-worktree edit passes untouched.
- A gitignored/scratch path (a main-checkout `tmp/` file, `/tmp`, another
  worktree's file, anything outside the repo) passes.
- When the main target's tracked status cannot be determined (e.g.
  `git check-ignore` errored), the hook fails SAFE: it treats the target as
  tracked and refuses.
- Override a deliberate main-checkout edit during an active cycle with
  `DEVLOOPS_ALLOW_MAIN=1 <command>`, the same override the default-branch
  guard uses.

### Post-merge cleanup

<!-- rule: WORKTREE-CLEANUP -->
`WORKTREE-CLEANUP`: After a successful merge, the canonical worktree MUST be
removed via this entrypoint, which resolves the path through the shared
resolver or, with `--branch`, selects the linked worktree that has the branch
checked out at the merged head, runs `git worktree remove` + `git worktree prune` from the
main checkout, and MUST NOT touch any path outside `tmp/worktrees/dev-loops/`.
The `--issue`, `--pr` and `--path` selectors run `git worktree remove --force`. The automated
`--branch` removal runs without `--force`, so git refuses a dirty, untracked or
locked worktree and the cleanup reports a skip:

```sh
node scripts/loop/cleanup-worktree.mjs --repo-root <p> (--issue <n> | --pr <n> | --path <p> | --branch <name> [--head-sha <sha>])
```

Git errors are logged but never fatal, so cleanup can't break a
merge-completion flow. `--branch` selects the linked worktree under the
namespace that has the branch checked out. `--head-sha` removes it only when
its HEAD equals that SHA. A worktree that holds any file under
`tmp/gate-findings/` is skipped. With `--branch`, a worktree with uncommitted
changes (tracked or untracked, not gitignored) is skipped too.

`merge-pr.mjs` runs this cleanup itself after a confirmed merge, keyed on the
merged head branch and head SHA. It skips the cleanup when its own cwd or
script file is inside the worktree. Run the command above manually only as the
fallback when that step reports a skip or an error.

## Default rule: use a worktree for mutating local work

<!-- rule: WORKTREE-DEFAULT-USE -->
`WORKTREE-DEFAULT-USE`: Non-trivial local edits, PR follow-up, or
delegated/parallel work MUST use a dedicated git worktree, not the main
checkout. The default base is the repo's auto-detected default branch
(`origin/HEAD`, else `main`/`master` — `origin/main` only on a repo whose
actual default is `main`; the tooling fetches candidate remotes first,
best-effort, and honors an explicit `--base` override). The main checkout is
reserved for inspection, control, and lightweight status checks.

A shell's working directory can reset silently. Every mutating git command (`add`, `commit`, `push`, and any command
that reads or writes files) MUST address the tree explicitly rather than rely
on cwd: `git -C <absolute-worktree-path> ...` for git, and absolute paths for
test/build commands. The [default-branch guard](#default-branch-guard) above
is defense-in-depth for exactly this slip, not a substitute for it — the
guard has documented no-op paths; addressing the tree explicitly does not.

## Agent shell commands

<!-- rule: WORKTREE-NONINTERACTIVE-FILE-OPS -->
`WORKTREE-NONINTERACTIVE-FILE-OPS`: an agent MUST copy, move and delete files with `command cp -f`, `command mv -f` and `command rm -f`.

An operator shell may alias `cp`, `mv` and `rm` to their interactive `-i`
forms. An interactive prompt hangs an agent shell. The `command` prefix skips
the alias, and `-f` skips the prompt. A dispatch to an editing worker cites
this rule by ID.

<!-- rule: WORKTREE-SCRIPT-LAUNCHER-CWD -->
`WORKTREE-SCRIPT-LAUNCHER-CWD`: an agent MUST run a repo script either as one compound command that enters the target checkout first, `cd <checkout> && dev-loops-run scripts/<path>`, or as `dev-loops-run --repo-root <checkout> scripts/<path>`. A dispatched pull line is exempt and runs bare.

Each Bash call may start in another checkout, and the working directory does
not persist between calls. A standalone `cd <checkout>` call followed by a
separate `dev-loops-run` call therefore runs the scripts of whichever checkout
the second call starts in. In the `--repo-root` form the launcher resolves the
toolchain from `<checkout>` when it is a dev-loops source checkout, and runs the
script with cwd `<checkout>`. A dispatched pull line runs bare, exactly as
dispatched, and is never prefixed with `cd`. `GATE-EXEC-NO-CWD-DEPENDENCE` in the
[Gate Review Sub-Loop Contract](./gate-review-sub-loop-contract.md) stays the
reviewer-specific rule and cites this one.

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
resolutions the entrypoint automates (see `branchOrigin` above):

- existing local branch: `git worktree add tmp/worktrees/dev-loops/<kind>-<number> <branch>`
- existing same-name remote branch on any candidate remote:
  `git worktree add -b <branch> --track tmp/worktrees/dev-loops/<kind>-<number> <remote>/<branch>`
- neither: `git worktree add -b <branch> tmp/worktrees/dev-loops/<kind>-<number> origin/<auto-detected-default>`
  (e.g. `origin/main`, or `origin/master` on a repo whose actual default is `master`)

Never fork off base when a same-name remote branch exists; that drops the
branch's commits.

## Dependency and install expectations

<!-- rule: WORKTREE-DEPS-ISOLATED -->
`WORKTREE-DEPS-ISOLATED`: A worktree's dependencies MUST NOT be assumed present
or valid from the main checkout's `node_modules`; run the repository-pinned
Bun 1.4.1 command `bun install --frozen-lockfile` inside the worktree whenever
it needs dependencies. If the frozen install reports manifest/`bun.lock` drift,
fix and commit the lockfile deliberately rather than weakening the frozen mode.

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

A merge through `merge-pr.mjs` removes the merged branch's worktree. After a
merge that reports a cleanup skip, or when the work is abandoned, run
`cleanup-worktree.mjs` promptly ([Post-merge cleanup](#post-merge-cleanup),
`WORKTREE-CLEANUP`).

## Never `git stash` in a shared-`.git` layout

<!-- rule: WORKTREE-NO-STASH -->
`WORKTREE-NO-STASH`: Agents MUST NOT run `git stash` (or `git stash pop`/`apply`) in this repo.
`refs/stash` is a single ref shared by every worktree over this repo's one `.git` directory, so a
stash pushed from one worktree can pop into a different worktree. Inspect working-tree changes with `git diff` (or
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
- Not a `node_modules` mirroring mechanism — deps belong to a frozen Bun install in the worktree.
- No expansion of this guidance into a second backlog or planning system.
