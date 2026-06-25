# GitHub Projects V2 queue board setup

One-time manual setup for the GitHub Projects V2 board that `dev-loop queue` helpers will read and write.

## Why a Projects V2 board?

The board provides durable, visible, shared state for queue ordering and item status — complementing the local queue persistence in `.pi/dev-loop-queue.json`. Board state is:

- **Durable** — survives CI restarts, local machine wipes, and session boundaries
- **Visible** — operators can inspect and reorder the queue from the GitHub UI
- **Optional** — queue helpers treat board state as an optional scheduling input, not mandatory authority. Without the board, `dev-loop queue` falls back to positional argument ordering.

## Setup

### 1. Create the project board

Run the idempotent bootstrap wrapper:

```sh
dev-loops project ensure --repo mfittko/dev-loops
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
dev-loops project ensure --repo mfittko/dev-loops --title "My Queue"
```

### 2. Verify the Status field

The wrapper creates a **Status** single-select field with these columns:

| Column | Meaning |
| --- | --- |
| **Backlog** | Not yet scheduled |
| **Next Up** | Next item(s) the queue should pick up |
| **In Progress** | Currently running through the dev-loop |
| **Done** | Completed (merged or explicitly closed) |

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
- **Add** new items to the `Backlog` column when issues are queued
- **Move** items to `In Progress` when processing starts, `Done` when complete
- **Reorder** items when the operator adjusts priority via `--after` dependencies or manual intervention
- **Fall back** gracefully when the board is absent: positional argument order takes over, and no board mutations are attempted

Use `dev-loops project --help` to inspect the queue helper surface and per-subcommand `--help` for details.

## Reordering board items

`dev-loops project reorder` wraps the `updateProjectV2ItemPosition` mutation. In
addition to the flag form (`--item [--after]`), it exposes three ergonomic
subcommands. A `<ref>` is an issue/PR **number** or a project **item node ID**,
and every form works for both issues and PRs.

```sh
# Move issue/PR #630 to the top of its current Status column
dev-loops project reorder move-to-top 630 --repo mfittko/dev-loops --project 1

# Move #630 immediately after #625
dev-loops project reorder move-after 630 625 --repo mfittko/dev-loops --project 1

# Set an explicit order: 103 first, then 101, then 102
dev-loops project reorder order 103 101 102 --repo mfittko/dev-loops --project 1
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
dev-loops project reorder order 103 101 102 --repo mfittko/dev-loops --project 1 --dry-run
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

`dev-loops project archive-done` removes finished work from the board. It archives
items (via `archiveProjectV2Item`) whose issue or PR has been **closed** for at
least the given duration. The closed state — not the board Status column — is the
criterion (a closed issue/PR is "done" for cleanup purposes), so a closed item is
archived regardless of which column it still sits in. It is operator-triggered (no
webhooks) and scoped to the single repo passed via `--repo`.

```sh
# Archive items whose issue/PR closed more than 30 days ago (default)
dev-loops project archive-done --repo mfittko/dev-loops --project 1

# Custom threshold (units: h = hours, d = days, w = weeks)
dev-loops project archive-done --repo mfittko/dev-loops --project 1 --older-than 7d

# Preview without mutating
dev-loops project archive-done --repo mfittko/dev-loops --project 1 --dry-run
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
dev-loops project ensure --repo mfittko/dev-loops
```

When drift is detected, the JSON output includes `repairs.renameCandidates` but leaves existing columns untouched.

Rename equivalent columns after review:

```sh
dev-loops project ensure --repo mfittko/dev-loops --repair-rename
```

This renames recognized equivalents (for example `Ready` -> `Next Up`) and adds any still-missing standard columns. It never removes existing columns. Irreconcilable conflicts (for example both `Ready` and `Next` mapping to `Next Up`) are reported in `repairs.conflicts` and no mutation is performed (no renames and no additive column creation).

### Fail-closed behavior

Queue helpers never silently assume board state is correct:

| What | Behavior |
| --- | --- |
| Board not found | Fall back to positional argument ordering; no board mutations |
| Board found but Status field missing | Error — must be reconciled before queue operations |
| Board found but Status column missing expected option | Error (exit code 3) — manual reconciliation needed; bootstrap wrapper fails closed |
| GitHub API returns an error | Operation fails; queue continues with next item |

## Configuration

Queue mode configuration lives under `.devloops` at repo root:

```yaml
queue:
  maxParallel: 3
  maxAutoFiledIssues: 10
  reDispatchMaxRetries: 1
```

The queue board URL and number are discoverable at runtime — no explicit config entry required.

## See also

- [Queue mode SPEC](./specs/queue-mode/SPEC.md) — full queue mode specification
- Issue [#632](https://github.com/mfittko/dev-loops/issues/632) — this setup task
- Issue [#625](https://github.com/mfittko/dev-loops/issues/625) — parent epic
- Issue [#631](https://github.com/mfittko/dev-loops/issues/631) — queue workflow documentation
