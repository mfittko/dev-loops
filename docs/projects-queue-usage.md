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

When a board **is** configured, `Next Up` is the authoritative, fail-closed pickup source per
`QUEUE-NEXTUP-SOURCE` (see [How dev-loop treats board state](#how-dev-loop-treats-board-state)
below and the [Projects Queue Contract](./projects-queue-contract.md#queue-pickup-ordering) for
the full rule set). When **no** board is configured, the queue falls back to its local entry
order (`.pi/dev-loop-queue.json`).

## How to opt in

The queue board is discovered at runtime by project number or node ID via `--project`.
No configuration file entry is required — helpers use explicit CLI arguments.

First, bootstrap the board (one-time):

```sh
dev-loops queue ensure --repo <owner/name>
```

The wrapper emits the project number and URL. Use the project number in subsequent
helper invocations.

## How to use the helpers

Queue management lives under `dev-loops queue <subcommand>` (run `dev-loops queue --help` to
list them). `dev-loops project <subcommand>` is kept as a back-compat alias for the same
scripts. All helpers are thin wrappers around `gh api graphql`. They emit machine-readable JSON
on stdout and structured errors on stderr. All accept `--help` for usage.

### List queue items

```sh
# List all items in a project
dev-loops queue list --repo mfittko/dev-loops --project 1

# List only items in "Next Up" column
dev-loops queue list --repo mfittko/dev-loops --project 1 --column "Next Up"

# Limit to top 5 items
dev-loops queue list --repo mfittko/dev-loops --project 1 --limit 5
```

### Add an item to the queue

```sh
# Add issue #42 to the Backlog column (default = unprioritized intake).
# Backlog items are NEVER auto-picked; promote to Next Up to schedule them.
dev-loops queue add --repo mfittko/dev-loops --project 1 --item 42

# Enqueue for immediate work: land directly in Next Up (the normative pickup
# queue). --next-up is sugar for --column "Next Up".
dev-loops queue add --repo mfittko/dev-loops --project 1 --item 42 --next-up

# Add issue #42 to a specific column (--status is a back-compat alias for --column)
dev-loops queue add --repo mfittko/dev-loops --project 1 --item 42 --column "Next Up"
```

### Move an item between columns

```sh
# Move issue #42 from its current column to In Progress
dev-loops queue move --repo mfittko/dev-loops --project 1 --item 42 --to-column "In Progress"

# Move a project item by its node ID
dev-loops queue move --repo mfittko/dev-loops --project 1 --item "PVTI_..." --to-column "Done"
```

### Reorder items

```sh
# Move issue #42 to the top of the column
dev-loops queue reorder --repo mfittko/dev-loops --project 1 --item 42

# Move issue #42 after issue #17
dev-loops queue reorder --repo mfittko/dev-loops --project 1 --item 42 --after 17

# Reorder by project item node IDs
dev-loops queue reorder --repo mfittko/dev-loops --project 1 --item "PVTI_abc" --after "PVTI_xyz"
```

### Typical workflow

1. Bootstrap the board once: `dev-loops queue ensure --repo <owner/name>`
2. Add items as they are queued: `dev-loops queue add --repo ... --project <n> --item <issue>`
3. Reorder by priority: drag in the GitHub UI, or use `dev-loops queue reorder`
4. When a worker picks up an item: `dev-loops queue move ... --to-column "In Progress"`
5. When done: `dev-loops queue move ... --to-column "Done"`
6. Inspect the queue at any time: `dev-loops queue list ...`

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

`QUEUE-BOOTSTRAP-ONLY-MUTATOR` (see the [Projects Queue Contract](./projects-queue-contract.md#idempotent-bootstrap-exception))
applies here: `dev-loops project ensure` is the only helper allowed to **create** project
structure, and it safely re-runs — if the board and Status field already exist, it exits clean
with the existing project details.

## How dev-loop treats board state

When a board is **configured** (`queue.board.number` or `queue.board.title` in `.devloops`),
it is the **authoritative source of queue membership and ordering** — not just status.
`dev-loops queue run` resolves the board's `Next Up` column and reconciles those items into
`.pi/dev-loop-queue.json` (appending a queued entry for any `Next Up` issue not already
present) before running, then dispatches under `QUEUE-NEXTUP-SOURCE`. Enqueue work for
immediate pickup via `dev-loops queue add ... --next-up` rather than hand-editing the queue
file. See [Queue pickup ordering](./projects-queue-contract.md#queue-pickup-ordering) for the
full fail-closed rule set (`QUEUE-NEXTUP-EMPTY-FAIL-CLOSED`, `QUEUE-BOARD-QUERY-FAIL-CLOSED`,
`QUEUE-NEXTUP-TARGET-MISSING-FAIL-CLOSED`) — an outage or an empty `Next Up` halts the run
rather than falling back to Backlog or local order. When **not** configured, the queue falls
back to its local entry order (`.pi/dev-loop-queue.json`), and the legacy "Queue is empty"
message applies when that file has no pending entries.

> **Limitation:** the normative `Next Up` rule (and `--next-up`, `queue add`/`list`/`move`)
> currently assumes the **default** `Next Up` display name. Renaming the logical column via
> `queue.statusColumns.next_up` (and siblings) is respected by board-sync but **not** yet by the
> ordering + projects-script layer, so a renamed Next Up column is not fully supported here.
> Honoring `statusColumns` across those layers is tracked in #1098.

### Issue-less lightweight PRs on the board

An issue-less lightweight PR (`resolve-dev-loop-startup.mjs --lightweight` alone, per
[ARTIFACT-LIGHTWEIGHT-PLAN-FILE-EXCLUSIVE](../skills/docs/artifact-authority-contract.md#lightweight-pr-body-as-spec))
has no tracker issue, so it appears on the board as a **PR item only** — there is no
issue-backed board entry to reconcile or close for it.
`scripts/github/create-pr.mjs --lightweight` owns enqueuing that PR item on creation
(In Progress, on a board-configured repo); a tracker-backed PR never triggers this call.

### Live pickup path (`/loop-continue`)

The operator-facing pickup path (bare `/loop-continue`) enforces `QUEUE-LIVE-PICKUP-SOURCE` via
`scripts/projects/resolve-active-board-item.mjs`: it continues the single **In Progress** item;
if there is none, it picks the **HEAD of `Next Up` by position** (`source: "next-up"`), failing
closed on an empty `Next Up`, more than one In-Progress item (pass an explicit
`/loop-continue #N`), or a `Next Up` query error — see the contract for the exact outcomes.

### Completion is reflected, never fabricated

The queue runner is a **deterministic adapter** over the board — it is **not** the orchestration
harness. It moves an item to **Done** (and marks the entry `done`) only as a reflection of a
**real terminal signal** supplied by an orchestrator (e.g. the item's linked PR merged), never as
a side effect of a resolve/run pass. When no orchestrator is wired into the current harness,
`dev-loops queue run` is a **no-op**: it leaves every board column unchanged and reports
`reason: "no-orchestrator"` rather than fabricating completion for unperformed work (#913).

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
