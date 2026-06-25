# Opt-in GitHub Projects queue workflow

This document is the practical operator's guide for using GitHub Projects V2 as an optional
scheduling view for `dev-loop` queue work. For the formal board contract, see
[Projects Queue Contract](./projects-queue-contract.md). For one-time setup, see
[Queue Board Setup](./queue-board-setup.md).

## Why board state is OK for outer queue ordering

The dev-loop can use GitHub Projects V2 board **position** as a human-readable scheduling
hint — not as a database or transactional state store.

- **Board state is durable** — survives CI restarts, local machine wipes, and session boundaries
- **Board state is visible** — operators inspect and reorder the queue from the GitHub UI
- **Board state is authoritative when configured** — a configured board is the source of queue membership and ordering; the queue runner reconciles its `Next Up` items into `.pi/dev-loop-queue.json` before running. When no board is configured, the local queue file's entry order is used.
- **No local queue file duplication** — the board drives membership/ordering while `.pi/dev-loop-queue.json` tracks entry lifecycle; the board does not introduce a second local file

This means board position is a **good-enough** signal for ordering the outer queue. The board
does not need to be transactionally consistent with local state for the queue to work correctly:
if a board operation fails, the queue continues; if the board is absent, the queue falls back
to its default entry order.

## How to opt in

The queue board is discovered at runtime by project number or node ID via `--project`.
No configuration file entry is required — helpers use explicit CLI arguments.

First, bootstrap the board (one-time):

```sh
dev-loops project ensure --repo <owner/name>
```

The wrapper emits the project number and URL. Use the project number in subsequent
helper invocations.

## How to use the helpers

All helpers are thin wrappers around `gh api graphql`. They emit machine-readable JSON on
stdout and structured errors on stderr. All accept `--help` for usage.

### List queue items

```sh
# List all items in a project
dev-loops project list --repo mfittko/dev-loops --project 1

# List only items in "Next Up" column
dev-loops project list --repo mfittko/dev-loops --project 1 --column "Next Up"

# Limit to top 5 items
dev-loops project list --repo mfittko/dev-loops --project 1 --limit 5
```

### Add an item to the queue

```sh
# Add issue #42 to the Backlog column (default)
dev-loops project add --repo mfittko/dev-loops --project 1 --item 42

# Add issue #42 to a specific column
dev-loops project add --repo mfittko/dev-loops --project 1 --item 42 --status "Next Up"
```

### Move an item between columns

```sh
# Move issue #42 from its current column to In Progress
dev-loops project move --repo mfittko/dev-loops --project 1 --item 42 --to-column "In Progress"

# Move a project item by its node ID
dev-loops project move --repo mfittko/dev-loops --project 1 --item "PVTI_..." --to-column "Done"
```

### Reorder items

```sh
# Move issue #42 to the top of the column
dev-loops project reorder --repo mfittko/dev-loops --project 1 --item 42

# Move issue #42 after issue #17
dev-loops project reorder --repo mfittko/dev-loops --project 1 --item 42 --after 17

# Reorder by project item node IDs
dev-loops project reorder --repo mfittko/dev-loops --project 1 --item "PVTI_abc" --after "PVTI_xyz"
```

### Typical workflow

1. Bootstrap the board once: `dev-loops project ensure --repo <owner/name>`
2. Add items as they are queued: `dev-loops project add --repo ... --project <n> --item <issue>`
3. Reorder by priority: drag in the GitHub UI, or use `dev-loops project reorder`
4. When a worker picks up an item: `dev-loops project move ... --to-column "In Progress"`
5. When done: `dev-loops project move ... --to-column "Done"`
6. Inspect the queue at any time: `dev-loops project list ...`

## Fail-closed behavior

Every helper validates preconditions before mutating board state. No helper silently assumes
the board is in a correct state.

| Situation | Behavior |
|---|---|
| Project not found by number or ID | Operation fails; exit code 3 |
| Board exists but Status field missing | Operation fails; exit code 3 |
| Board exists but expected Status column missing | Operation fails; exit code 3 |
| GitHub API returns an error | Operation fails; exit code 2 |
| Item not found on board (move/reorder) | Operation fails; exit code 3 |
| Self-referential reorder (`--after` same as `--item`) | Operation fails with clear error message |

### Error format

On failure, helpers emit structured JSON on stderr:

```json
{"ok": false, "error": "Item #999 not found in project for repo \"owner/name\"", "code": "ITEM_NOT_FOUND"}
```

Exit codes:
- `1` — usage or argument error
- `2` — GitHub API error
- `3` — project, field, column, or item not found

### Idempotent bootstrap exception

The `dev-loops project ensure` bootstrap wrapper is the only helper allowed to **create**
project structure. It safely re-runs: if the board and Status field already exist, it exits
clean with the existing project details. Runtime helpers (list, move, add, reorder) never
create or modify project/field structure.

## How dev-loop treats board state

When a board is **configured** (`queue.projectNumber` or `queue.boardTitle` in `.devloops`),
it is the **authoritative source of queue membership and ordering** — not just status:

- **Configured and reachable**: `dev-loop queue run` resolves the board's `Next Up` column and
  reconciles those items into `.pi/dev-loop-queue.json` (appending a queued entry for any
  `Next Up` issue not already present) before running. The board therefore drives **which**
  issues are worked and their order. Enqueue work via `dev-loops project add ... --status "Next Up"`
  rather than hand-editing the queue file.
- **Configured but unreachable (API error)**: reconciliation fails open — the run continues
  with the existing local queue entries; no board mutations are attempted.
- **Configured but `Next Up` is empty**: the run reports "Board configured but Next Up is empty;
  nothing to run", distinct from the unconfigured "Queue is empty".
- **Not configured**: the queue falls back to its local entry order (`.pi/dev-loop-queue.json`),
  and the legacy "Queue is empty" message applies when that file has no pending entries.

This posture keeps the queue resilient: a transient GitHub API outage or misconfigured board
does not block the run. Board state is read at dispatch time; the queue does not continuously
sync local state to board state.

## See also

- [Projects Queue Contract](./projects-queue-contract.md) — formal board contract
- [Queue Board Setup](./queue-board-setup.md) — one-time setup guide
- Issue [#625](https://github.com/mfittko/dev-loops/issues/625) — parent epic
- Issue [#626](https://github.com/mfittko/dev-loops/issues/626) — queue contract
- Issue [#627](https://github.com/mfittko/dev-loops/issues/627) — list helper
- Issue [#628](https://github.com/mfittko/dev-loops/issues/628) — move helper
- Issue [#629](https://github.com/mfittko/dev-loops/issues/629) — add helper
- Issue [#630](https://github.com/mfittko/dev-loops/issues/630) — reorder helper
- Issue [#631](https://github.com/mfittko/dev-loops/issues/631) — this doc
- Issue [#632](https://github.com/mfittko/dev-loops/issues/632) — board bootstrap
