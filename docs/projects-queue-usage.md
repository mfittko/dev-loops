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

When a board **is** configured, `Next Up` is the authoritative, **fail-closed** pickup source:
the driver picks only `Next Up` members by position and, if the board query fails, **stops**
rather than falling back (see the pickup-behavior list below and the contract). When **no** board
is configured, the queue falls back to its local entry order (`.pi/dev-loop-queue.json`).

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

The `dev-loops project ensure` bootstrap wrapper is the only helper allowed to **create**
project structure. It safely re-runs: if the board and Status field already exist, it exits
clean with the existing project details. Runtime helpers (list, move, add, reorder) never
create or modify project/field structure.

## How dev-loop treats board state

When a board is **configured** (`queue.projectNumber` or `queue.boardTitle` in `.devloops`),
it is the **authoritative source of queue membership and ordering** — not just status:

- **Configured and reachable**: `dev-loops queue run` resolves the board's `Next Up` column and
  reconciles those items into `.pi/dev-loop-queue.json` (appending a queued entry for any
  `Next Up` issue not already present) before running. `Next Up` is the **normative, fail-closed
  pickup source**: the driver picks **only** `Next Up`
  members, by POSITION ascending, and **never** auto-pulls from Backlog. **Backlog is
  unprioritized intake and is never auto-picked** — promote an item to `Next Up` (the deliberate
  prioritization step) to schedule it. Enqueue work for immediate pickup via
  `dev-loops queue add ... --next-up` rather than hand-editing the queue file. See the
  "Queue pickup ordering" section of `docs/projects-queue-contract.md` for the full MUST-level
  contract (including the empty-`Next Up` fail-closed idle and why a single-issue/PR run — which
  runs via the dev-loop routing path, not the queue driver — is unaffected by `Next Up` gating).
- **Configured but unreachable (API error)**: the driver **fails closed** and stops with
  `reason: "board-query-error"` (see the contract). It does **not** fall back to Backlog or to
  local queue order — an outage never silently drains Backlog. (The separate membership-reconcile
  pre-step is fail-open and attempts no board mutations on error, but the driver then re-queries
  `Next Up` itself and stops on the same error, so the net outcome is a halted run, not a
  local-order run.)
- **Configured but `Next Up` is empty**: the run reports "Board configured but Next Up is empty;
  nothing to run", distinct from the unconfigured "Queue is empty".
- **Configured but a `Next Up` target is missing locally**: when `Next Up` lists an item with no
  matching entry in `.pi/dev-loop-queue.json` (reconcile not run/persisted, or the board changed
  since reconcile), the driver **fails closed** and stops with `reason: "next-up-target-missing-locally"`
  (the offending numbers in `missingTargets`) rather than silently skipping the item. Run membership
  reconcile / re-add the items. No Backlog pickup.
- **Not configured**: the queue falls back to its local entry order (`.pi/dev-loop-queue.json`),
  and the legacy "Queue is empty" message applies when that file has no pending entries.

Board state is read at dispatch time; the queue does not continuously sync local state to board
state. When a board is configured, the pickup posture is deliberately **fail-closed**: a transient
GitHub API outage or unresolvable board halts the run (`board-query-error`) rather than dispatching
an unprioritized or stale set — an outage never silently drains Backlog. Only the **unconfigured**
case falls back to local entry order.

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
