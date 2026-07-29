# GitHub Projects V2 queue board setup

One-time manual setup for the GitHub Projects V2 board that `dev-loops queue` helpers will read and write.

## Why a Projects V2 board?

The board provides durable, visible, shared state for queue ordering and item status — complementing the local queue persistence in `.pi/dev-loop-queue.json`. Board state is:

- **Durable** — survives CI restarts, local machine wipes, and session boundaries
- **Visible** — operators can inspect and reorder the queue from the GitHub UI
- **Authoritative for membership + ordering when configured** — when a board is configured (`tracker.board`, or the deprecated `queue.board`; `number` or `title`), `dev-loops queue run` reconciles the board's `Next Up` items into `.pi/dev-loop-queue.json` before running, so the board (not hand edits) drives **which** issues are worked and their order. Without a configured board, `dev-loops queue` falls back to the local queue file's entry order.

> Add work to the queue via the board (`dev-loops queue add ... --column "Next Up"`), not by hand-editing `.pi/dev-loop-queue.json`. With a populated board and an empty local queue, the runner reconciles the board's `Next Up` items in rather than reporting an empty queue. If a board is configured but `Next Up` is empty, the runner reports the canonical "queue empty — prioritize Backlog items into Next Up" (`reason: "next-up-empty"`) — distinct from the unconfigured-and-empty "Queue is empty".

## Setup

### 1. Create the project board

Run the idempotent bootstrap wrapper:

```sh
dev-loops queue ensure --repo mfittko/dev-loops
```

This creates a project named "Dev Loop Queue" (default) under the `mfittko` user:

```json
{
  "ok": true,
  "project": {
    "id": "PVT_kwDO...",
    "number": 1,
    "title": "Dev Loop Queue",
    "url": "https://github.com/users/mfittko/projects/1",
    "statusFieldId": "PVTSSF_lADO..."
  }
}
```

Safe to re-run — exits clean if the board already exists.

#### Custom title

```sh
dev-loops queue ensure --repo mfittko/dev-loops --title "My Queue"
```

### 2. Verify the Status field

The wrapper creates a **Status** single-select field with the four canonical columns defined
by `QUEUE-COLUMN-CANONICAL` (Backlog, Next Up, In Progress, Done) — see
[Conventional columns](./projects-queue-contract.md#conventional-columns) in the Projects
Queue Contract for the owning definition.

After creation, verify in the GitHub UI: open the project URL from the wrapper output, confirm the Status field exists with all four columns.

### 3. Manual setup alternative

To create the board manually via GitHub UI:

1. Go to your GitHub profile → **Projects** tab
2. Click **New project**
3. Select **Board** layout
4. Name it "Dev Loop Queue"
5. Add a **Status** field (type: Single select)
6. Add options: `Backlog`, `Next Up`, `In Progress`, `Done`
7. Record the project number from the URL: `https://github.com/users/<owner>/projects/<number>`

After manual creation, the wrapper's idempotent re-run will detect the existing board and Status field and emit the same machine-readable JSON payload.

## How queue helpers use the board

Dev-loop queue wrappers will:

- **List** items from the board ordered by position
- **Add** new items to the `Backlog` column when issues are queued; promote to `Next Up` to enqueue them for the runner
- **Drive membership + ordering** from the board's `Next Up` column: `dev-loops queue run` reconciles `Next Up` items into queue entries before running (configured board is authoritative)
- **Move** items to `In Progress` when processing starts, `Done` when complete
- **Reorder** items when the operator adjusts priority via `--after` dependencies or manual intervention
- **Fall back** gracefully when the board is absent or unreachable: the local queue file's entry order takes over, and no board mutations are attempted

Use `dev-loops queue --help` to inspect the queue helper surface and per-subcommand `--help` for details.

## Status sync is driven by the loop state

The board **Status** column is kept in sync with the dev-loop's own state machine
rather than from hardcoded strings. A pure mapping
(`boardColumnForLoopState(loopState, mapping)` in
`packages/core/src/loop/queue-board-sync.mjs`) resolves each loop/lifecycle state
to a logical column, then to a configured display name.

### State → logical column (defaults)

| Loop / lifecycle state | Logical column | Default display name |
| --- | --- | --- |
| `issue_opened`, `issue_intake`, `refinement`, `no_pr`, `pr_draft` | `next_up` | **Next Up** |
| `implementation`, `local_implementation_active`, `pr_ready_no_feedback`, `waiting_for_copilot_review`, `ready_to_rerequest_review`, `unresolved_feedback_present`, `already_fixed_needs_reply_resolve`, `waiting_for_ci`, `blocked_needs_user_decision`, other in-flight states | `in_progress` | **In Progress** |
| `final_approval_ready`, `pre_approval_gate` | `ready_for_review` | **In Progress** (unless overridden, see below) |
| `merged`, `issue_closed`, `done`, `merge` | `done` | **Done** |
| _any unmapped state_ | `in_progress` | **In Progress** (safe default — work is visibly active rather than dropped) |

The mapping is **stateless**: it depends only on the current state, so a reverted
state moves the column backward automatically. For example, a merged PR that is
reopened maps back from **Done** to **In Progress**, and a ready PR demoted to a
draft maps back from **In Progress** to **Next Up**. No "furthest reached" column
is persisted.

### Configuring column names (opt-in)

Both overrides live under the opt-in `queue` section in `.devloops`; board sync
itself is enabled by a configured board (`tracker.board`, or the deprecated
`queue.board`; `number` or `title`). When no board is configured or sync is
disabled, status sync is a **no-op**: it makes **no
GitHub API calls and no board mutations**. (It may still read the local
`.devloops` config in order to determine that sync is disabled.)

`queue.statusColumns` renames the display name of a logical column:

```yaml
queue:
  board:
    number: 7
  statusColumns:
    next_up: "Todo"
    in_progress: "Doing"
    ready_for_review: "Ready for Review"   # opt-in column; otherwise final_approval_ready stays "In Progress"
    done: "Shipped"
```

`queue.stateColumnMap` remaps an individual loop state to a different logical
column (rarely needed):

```yaml
queue:
  board:
    number: 7
  stateColumnMap:
    blocked_needs_user_decision: next_up
```

### No-op behavior

- **Board not configured / disabled** — sync returns `{ ok: true, skipped: true }`
  and performs no GitHub calls (AC2/AC6).
- **Item not on the board** — sync is a logged no-op (`{ ok: true, skipped: true }`),
  never an error, so a missing board item can never break the loop (AC4).

## Reordering board items

`dev-loops queue reorder` wraps the `updateProjectV2ItemPosition` mutation. In
addition to the flag form (`--item [--after]`), it exposes three ergonomic
subcommands. A `<ref>` is an issue/PR **number** or a project **item node ID**,
and every form works for both issues and PRs.

```sh
# Move issue/PR #630 to the top of its current Status column
dev-loops queue reorder move-to-top 630 --repo mfittko/dev-loops --project 1

# Move #630 immediately after #625
dev-loops queue reorder move-after 630 625 --repo mfittko/dev-loops --project 1

# Set an explicit order: 103 first, then 101, then 102
dev-loops queue reorder order 103 101 102 --repo mfittko/dev-loops --project 1
```

The subcommand forms emit diff-friendly JSON with the column order **before** and
**after** the change, plus the resolved item IDs:

```json
{
  "ok": true,
  "item": { "itemId": "PVTI_b", "issueNumber": 630, "prNumber": null, "status": "Next Up", "position": "top" },
  "after_ref": null,
  "before": [
    { "itemId": "PVTI_a", "issueNumber": 625, "prNumber": null, "status": "Next Up" },
    { "itemId": "PVTI_b", "issueNumber": 630, "prNumber": null, "status": "Next Up" }
  ],
  "after": [
    { "itemId": "PVTI_b", "issueNumber": 630, "prNumber": null, "status": "Next Up" },
    { "itemId": "PVTI_a", "issueNumber": 625, "prNumber": null, "status": "Next Up" }
  ]
}
```

Each snapshot entry carries `itemId`, `issueNumber`, `prNumber` (one of the latter
two is `null`), and `status`. `order` returns a `moves` array (one entry per chained
position mutation) plus the same `before`/`after` snapshots.

> **`order` is not atomic.** It applies N sequential `updateProjectV2ItemPosition`
> mutations with no rollback. If it fails partway, the board is left partially
> reordered and the thrown error reports how many moves completed (for example
> `order partially applied: 1 of 3 moves completed`). Re-running the **same**
> `order <ref1> <ref2> ...` command is idempotent and is the supported recovery
> path — it re-applies the full target sequence.

### Dry run

Add `--dry-run` to any form to print the intended GraphQL mutation(s) — including
the chained mutations for `order` — without executing them:

```sh
dev-loops queue reorder order 103 101 102 --repo mfittko/dev-loops --project 1 --dry-run
```

```json
{
  "ok": true,
  "dryRun": true,
  "mutations": [
    { "query": "mutation(...) { updateProjectV2ItemPosition(...) }", "variables": { "projectId": "PVT_proj1", "itemId": "PVTI_3" } },
    { "query": "...", "variables": { "projectId": "PVT_proj1", "itemId": "PVTI_1", "afterId": "PVTI_3" } }
  ],
  "before": [
    { "itemId": "PVTI_1", "issueNumber": 101, "prNumber": null, "status": "Next Up" },
    { "itemId": "PVTI_2", "issueNumber": 102, "prNumber": null, "status": "Next Up" },
    { "itemId": "PVTI_3", "issueNumber": 103, "prNumber": null, "status": "Next Up" }
  ]
}
```

The flag form (`--item [--after] --dry-run`) returns the same `{ mutations, before }`
shape with a single mutation.

A ref that does not resolve to an item in the target Project fails closed with a
clear `ITEM_NOT_FOUND` error (exit code 3) — only items in the target Project can
be reordered.

## Archiving completed items

`dev-loops queue archive-done` removes finished work from the board. It archives
items (via `archiveProjectV2Item`) whose issue or PR has been **closed** for at
least the given duration. The closed state — not the board Status column — is the
criterion (a closed issue/PR is "done" for cleanup purposes), so a closed item is
archived regardless of which column it still sits in. It is operator-triggered (no
webhooks) and scoped to the single repo passed via `--repo`.

```sh
# Archive items whose issue/PR closed more than 30 days ago (default)
dev-loops queue archive-done --repo mfittko/dev-loops --project 1

# Custom threshold (units: h = hours, d = days, w = weeks)
dev-loops queue archive-done --repo mfittko/dev-loops --project 1 --older-than 7d

# Preview without mutating
dev-loops queue archive-done --repo mfittko/dev-loops --project 1 --dry-run
```

Output distinguishes the items scanned from the actual archive candidates:

```json
{
  "ok": true,
  "olderThan": "30d",
  "scanned": 12,
  "archivable": 1,
  "archived": [{ "itemId": "PVTI_a", "issueNumber": 1, "prNumber": null, "closedAt": "2026-01-01T00:00:00Z" }]
}
```

- `scanned` — all board items belonging to the repo (open, closed, and archived).
- `archivable` — the subset selected for archival by the closed-duration filter.
- `archived` — the items actually archived (equals `archivable`, or empty under `--dry-run`).

Open items (even if parked in the `Done` column) and already-archived items are
never touched.


### Repairing drifted Status columns

Real boards drift over time. An operator may rename `Next Up` to `Ready`, or `In Progress` to `Doing`. The bootstrap wrapper can detect these semantically equivalent columns and, with explicit authorization, reconcile them back to the standard names.

Report drift without mutating (safe default):

```sh
dev-loops queue ensure --repo mfittko/dev-loops
```

When drift is detected, the JSON output includes `repairs.renameCandidates` but leaves existing columns untouched.

Rename equivalent columns after review:

```sh
dev-loops queue ensure --repo mfittko/dev-loops --repair-rename
```

This renames recognized equivalents (for example `Ready` -> `Next Up`) and adds any still-missing standard columns. It never removes existing columns. Irreconcilable conflicts (for example both `Ready` and `Next` mapping to `Next Up`) fail closed per `QUEUE-RENAME-CONFLICT-NO-MUTATION` in the [Projects Queue Contract](./projects-queue-contract.md#conflicts).

### Fail-closed behavior

Queue helpers never silently assume board state is correct — see the
[Fail-closed behavior](./projects-queue-contract.md#fail-closed-behavior) table in the
Projects Queue Contract for the situation/behavior/exit-code matrix.

## Configuration

Queue mode configuration lives under `.devloops` at repo root:

```yaml
queue:
  maxParallel: 3
  maxAutoFiledIssues: 10
  reDispatchMaxRetries: 1
```

The queue board URL and number are discoverable at runtime; recording the board in `.devloops`
(`tracker.board`) is what lets every queue command resolve it without `--project`
(`QUEUE-BOARD-DEVLOOPS-RESOLUTION`).

## See also

- the queue-mode SPEC (`docs/specs/queue-mode/SPEC.md`) — full queue mode specification
- Issue [#632](https://github.com/mfittko/dev-loops/issues/632) — this setup task
- Issue [#625](https://github.com/mfittko/dev-loops/issues/625) — parent epic
- Issue [#631](https://github.com/mfittko/dev-loops/issues/631) — queue workflow documentation
