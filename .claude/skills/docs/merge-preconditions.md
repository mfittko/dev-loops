# Merge preconditions

Canonical owner for merge preconditions across all workflow families.

## Required before merge

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

## Post-merge

- Remove merged worktree (canonical): `node scripts/loop/cleanup-worktree.mjs --repo-root <main> (--issue <n> | --pr <n>)`.
  It resolves the namespaced path, runs `git worktree remove --force <path> && git worktree prune` (the underlying
  mechanism) from the main checkout, and refuses any path not under `tmp/worktrees/dev-loops/`. See
  [worktree guidance](../../docs/worktree-guidance.md).
- Clean up stale branches

## Cross-references

- [Confirmation rules](confirmation-rules.md)
- [Validation policy](validation-policy.md)
- [Stop conditions](stop-conditions.md)
