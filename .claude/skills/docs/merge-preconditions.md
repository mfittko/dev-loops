# Merge preconditions

Canonical owner for merge preconditions across all workflow families.

## Conflict-free (mergeable) is a precondition at every gate

A PR that conflicts with its base gets **no `pull_request` CI run** — GitHub can't
compute the merge ref — so the gate silently stalls (green-less with no obvious
cause). Conflict-free is therefore a required gate precondition, checked at **two
seams**: before requesting CI/Copilot, and again before merge.

- `gh pr view --json mergeable,mergeStateStatus` drives it. A `CONFLICTING` /
  `DIRTY` / `BEHIND` PR does **not** pass any gate (`gateBoundary:
  conflict_resolution`, `nextAction: resolve_merge_conflicts`).
- `mergeable` is computed asynchronously, so a freshly-pushed head briefly reads
  `UNKNOWN`. The detect layer **re-polls a bounded number of times**; if it never
  settles, the gate **fails closed to a recheck** (`nextAction: wait_for_ci`) —
  an unsettled merge state is never treated as clean.
- `loop info` surfaces a **Mergeable:** line (mergeStateStatus included) so a
  conflict is diagnosed immediately, never mistaken for missing CI.

### Deterministic auto-resolve (additive CHANGELOG only)

When a PR is behind/`CONFLICTING`, run the conservative resolver before resuming
the gate path:

```sh
node scripts/loop/resolve-pr-conflicts.mjs [--base <branch>] [--push]
```

It merges `origin/<base>` into the PR branch and resolves **only the safe additive
case** — a `CHANGELOG.md` conflict where both sides only ADD list/section entries
(keep BOTH sides, in order) — then runs `npm run test:docs` and (with `--push`)
pushes. **Any other conflicted path, or a non-additive CHANGELOG edit, FAILS
CLOSED** naming the conflicted paths (no silent stall, no guessing — resolve those
by hand). This encodes the exact additive-CHANGELOG resolution the loop has been
doing manually; it is not a general conflict-resolution engine.

## Required before merge

1. ✅ Conflict-free with base (`mergeable: MERGEABLE`; not `CONFLICTING`/`DIRTY`/`BEHIND`/`UNKNOWN`)
1. ✅ CI green on current head (or crediblyGreen via `--local-validation-head-sha`)
2. ✅ Draft gate satisfied (clean verdict)
3. ✅ Pre-approval gate satisfied (clean verdict, current head)
4. ✅ All review threads resolved
5. ✅ Explicit merge authorization from operator
6. ✅ PR body contains `Closes #N` or `Fixes #N`
7. ✅ PR **title** free of merge-blocking markers — `WIP`, `[WIP]`, `DRAFT`, `DO NOT MERGE`, `🚧` (case-insensitive)

## Title markers

The PR title is a contract surface, so a merge-blocking marker in the title is enforced
deterministically (`findBlockingTitleMarkers` in `@dev-loops/core/loop/pr-title-markers`), not
just reviewed:

- At the **draft → ready-for-review** transition: `ready-for-review` refuses `gh pr ready` while the
  title carries a marker.
- At the **pre-approval gate boundary and final approval** (for non-draft PRs): the gate coordinator
  returns `title_marker_blocked` so a PR un-drafted externally still cannot enter pre-approval or
  reach merge-ready with a marked title.

A marker is allowed only while the PR is still in draft; it must be removed before the PR leaves draft.

## Merge authorization

- Must be explicit for the active issue/PR scope
- `"Merge authorized if gates green"` is valid explicit authorization
- Implied approval from prior turns is not sufficient

### `autonomy.humanMergeOnly` — fixed human-only merge (non-overridable)

When a repo sets `autonomy.humanMergeOnly: true` in `.devloops`, merge is a fixed
human action and this authorization step is **non-overridable**:

- `resolveAutonomyStopAt` always includes `merge`, even if `stopAt` is set to `[]`.
- The effective merge authorization fails closed: `resolveEffectiveMergeAuthorized`
  returns `false` regardless of the `mergeAuthorized` envelope flag or an explicit
  "merge" instruction. The lifecycle resolver therefore never advances to the merge
  state and parks at the `pre_approval_gate` human-merge handoff.
- The agent still runs the full mechanical pre-merge evidence check and reports
  merge-ready + gate evidence, then hands off to a human to perform `gh pr merge`.
  The agent **never** runs `gh pr merge` itself.

This makes human-gated merge an enforced repo invariant, not a per-run default an
explicit instruction can unlock.

### `approval.humanHandoff` — offer to assign a human at the handoff (opt-in)

When a repo sets `approval.humanHandoff.enabled: true` in `.devloops`, the loop
does not just park silently at the human-merge stop — at the
`pre_approval_gate` / `waiting_for_merge_authorization` boundary it **offers**
to route the PR to a contributor (pairs with `autonomy.humanMergeOnly`: when
human-merge is enforced, the handoff names who should take it). Disabled by
default; no candidate sourcing when disabled.

```yaml
approval:
  humanHandoff:
    enabled: true
    candidatesFrom: [codeowners, recent-committers]
    assignees: [alice, bob]
```

At the handoff boundary, resolve and surface candidates:

```sh
dev-loops gate offer-human-handoff --repo <owner/name> --pr <number>
```

This prints the deduped, ordered candidate list (priority:
`assignees` > `codeowners` for the touched paths (last-match-wins) >
`recent-committers` to those paths, PR author/bots excluded). It assigns no one.

**OFFER-only — the operator confirms the assignee** (auto-assigning without
confirmation is a non-goal). On confirmation, perform the action:

```sh
dev-loops gate offer-human-handoff --repo <owner/name> --pr <number> \
  --assign <login> --request-review <login>
```

which runs `gh pr edit --add-assignee` / `--add-reviewer` for the confirmed
human(s).

## Post-merge

- Remove merged worktree (canonical): `node scripts/loop/cleanup-worktree.mjs --repo-root <main> (--issue <n> | --pr <n>)`.
  It resolves the namespaced path, runs `git worktree remove --force <path> && git worktree prune` (the underlying
  mechanism) from the main checkout, and refuses any path not under `tmp/worktrees/dev-loops/`. See
  [worktree guidance](../../docs/worktree-guidance.md).
- Archive long-done queue items (operator-induced, NOT a cron): `node scripts/projects/archive-done-items.mjs --repo <owner/name> || true`.
  Runs as part of this post-merge hook. It applies the configured `queue.archiveOlderThanDays` (default `7d`) and archives
  board items whose issue/PR has been closed at least that long. Best-effort: run it as a standard post-merge step but ignore
  any non-zero exit (a successful run that finds nothing to archive exits 0; a board/config-resolution/API error exits
  non-zero, which the `|| true` masks) — a failure here must never block merge completion. See
  [projects queue usage](../../docs/projects-queue-usage.md).
- Clean up stale branches

## Cross-references

- [Confirmation rules](confirmation-rules.md)
- [Validation policy](validation-policy.md)
- [Stop conditions](stop-conditions.md)
