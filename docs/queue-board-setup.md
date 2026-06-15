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
