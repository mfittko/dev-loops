# GitHub Projects Queue Contract

Canonical owner for the GitHub Projects V2 queue board contract: board shape, the Status
column vocabulary, and `Next Up` pickup rules. This document also carries the one-time
[Setup](#setup) guide and the day-to-day [Usage](#usage) guide for the queue helpers, so the
contract and its operator-facing surfaces live in one place.

## Purpose

When a dev-loop operator opts into the GitHub Projects queue path, queue helpers read queue
ordering from a project board and write status transitions back, relying on deterministic
field/column names and failing safely when the board is absent or misconfigured.

<!-- rule: QUEUE-BOARD-LINKED -->
**The queue board MUST be linked to the target repository** via `linkProjectV2ToRepository`.
Repo-linked boards travel with the repository, are visible to all collaborators, and appear
in the repository's Projects tab. User-level (unlinked) projects are not supported for queue
ordering and must be migrated.

**Board state is an optional scheduling input; it does not replace GitHub issue/PR state as
the source of truth.** This contract introduces no new local queue file; it complements the
existing queue mode infrastructure (see Relationship to queue mode below).

## Opt-in posture

GitHub Projects is **optional**. The dev-loop works without a project board — queue helpers
fall back to positional argument ordering when no board is configured. Setting up a board is
a one-time operator action, not a startup requirement.

Tooling never mutates project/field structure without explicit operator invocation of the
bootstrap wrapper (`dev-loops project ensure`). Runtime queue operations only read/write item
position and Status field values.

## Board identification

<!-- rule: QUEUE-BOARD-DEVLOOPS-RESOLUTION -->
Every operator-facing `scripts/projects/*` queue command **MUST** resolve the board from
`.devloops` (`tracker.board` first, falling back to the deprecated `queue.board`; number or
title) when `--project` is omitted; an explicit `--project` overrides. The structural halves
(the `applyDevloopsBoard` call and `projectTitle` delegation forwarding) are enforced by
`test/contracts/queue-board-resolution-contract.test.mjs`, which inspects commands that read
`--project`/`args.project` and exempts the `_resolve-project.mjs` helper itself and the board
bootstrap `ensure-queue-board.mjs`. Omitted-flag and override behaviors are covered
behaviorally where suites exist (`resolve-active-board-item`, `list-queue-items`); the
remaining siblings are covered structurally only.

### Owner and project

A board is identified by its owning entity (user or organization) and project title.

Tooling resolves the owner from the repository slug (`--repo <owner/name>`) and looks up the
project by title among that owner's Projects V2 instances.

| Field | Source | Example |
|---|---|---|
| Owner | First component of repo slug | `mfittko` |
| Project title | Configurable; recommended title `"Dev Loop Queue"` | `"Dev Loop Queue"` |
| Project number | Assigned by GitHub on creation | `1` |

The owner can be a user or an organization. Tooling resolves both via the GraphQL API.

### Discovery

Tooling uses the following GraphQL query pattern for paginated project listing:

```graphql
query($login:String!, $after:String) {
  user(login:$login) {           # or organization(login:$login)
    projectsV2(first:50, after:$after) {
      pageInfo { hasNextPage, endCursor }
      nodes { id, number, title, url }
    }
  }
}
```

Project lookup is by **exact title match** against the configured title. If no project with
the configured title exists, tooling fails closed — it does not create a project silently.

## Required fields

At minimum, the board must have a **Status** field of type `single-select`. This is the only
required field; all queue-state read/write operations key off Status.

### Querying the Status field

```graphql
query($projectId:ID!, $after:String) {
  node(id:$projectId) {
    ... on ProjectV2 {
      fields(first:50, after:$after) {
        pageInfo { hasNextPage, endCursor }
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id, name }
          }
        }
      }
    }
  }
}
```

Tooling identifies the Status field by name (`"Status"`) and reads its option IDs.
Field ID and option IDs are used in subsequent mutations to set Status on items.

## Conventional columns

<!-- rule: QUEUE-COLUMN-CANONICAL -->
The Status field MUST contain these four columns; this is the single canonical definition of
the board-column vocabulary — other queue docs reference it by ID instead of restating it.
Tooling keys off the option **names**:

| Column | Meaning |
|---|---|
| **Backlog** | Unprioritized intake. Default Status for newly added items. Position within Backlog carries **no scheduling meaning** — the driver never picks from Backlog. Promoting an item to Next Up is the deliberate prioritization step. |
| **Next Up** | The **normative pickup order**. The driver picks **only** from this column, by POSITION ascending. |
| **In Progress** | Currently running through the dev-loop. |
| **Done** | Completed (merged or explicitly closed). |

Columns are case-sensitive exact matches. `"backlog"`, `"BACKLOG"`, or `"Backlog "` do not
match.

The bootstrap wrapper creates these four columns automatically. Operators may add additional
Status options.

<!-- rule: QUEUE-COLUMN-NO-REMOVE -->
Operators **MUST NOT remove or rename** the four conventional columns — tooling fails closed
when expected columns are missing.

## Queue ordering

Queue ordering is read from GitHub Projects V2 item **POSITION** within a Status-filtered
view.

### How ordering works

1. Tooling queries items for a specific Status column:

```graphql
query($projectId:ID!, $statusFieldId:ID!, $statusOptionId:ID!, $after:String) {
  node(id:$projectId) {
    ... on ProjectV2 {
      items(
        first:50, after:$after,
        orderBy: { field: POSITION, direction: ASC },
        filterBy: { fieldValues: [{ fieldId: $statusFieldId, optionId: $statusOptionId }] }
      ) {
        pageInfo { hasNextPage, endCursor }
        nodes {
          id
          fieldValues(first:10) {
            nodes {
              ... on ProjectV2ItemFieldTextValue { text }
            }
          }
          content {
            ... on Issue { number, title, url, state }
            ... on PullRequest { number, title, url, state }
          }
        }
      }
    }
  }
}
```

2. Items are returned in POSITION order (ascending), determined by the board's manual drag-drop
   or `updateProjectV2ItemPosition` API.

3. The operator reorders items by dragging within the GitHub Projects board UI or via the
   `reorder` helper. Tooling reads the resulting POSITION deterministically — it does not
   enforce its own ordering.

### Position semantics

- POSITION is a float maintained by GitHub. Items can be inserted between any two items.
- Ordering is **column-scoped**: the POSITION of an item in "Next Up" is independent of its
  position in "Backlog".
- A filtered query (`filterBy: { fieldValues: ... }`) returns only items in that column,
  ordered by POSITION.
- When the `--limit N` flag is used, tooling takes the first N items from the ordered result.

## Fail-closed behavior

Tooling never silently assumes board state is correct. Every operation that depends on the
board validates preconditions first:

| Situation | Behavior | Exit code |
|---|---|---|
| No board configured (not opted in) | Fall back to positional ordering; no board mutations | N/A (normal) |
| Board not found by title | Operation fails; no fallback to creation | 2 |
| Board exists but Status field missing | Operation fails; manual reconciliation needed | 3 |
| Board exists but Status field missing expected column | Operation fails; manual reconciliation needed | 3 |
| GitHub API returns error | Operation fails; queue continues with next item | 2 |
| Item not found on board (move/add operation) | Operation fails; no silent creation | 2 |

### Idempotent bootstrap exception

<!-- rule: QUEUE-BOOTSTRAP-ONLY-MUTATOR -->
The `dev-loops project ensure` bootstrap wrapper has relaxed fail-closed behavior: it
**creates** a missing project and/or Status field with conventional columns. It **MUST** be
the only tool that mutates project structure; runtime queue helpers (list, move, add,
reorder) **MUST NOT** create or modify project/field structure.

### Error reporting

When tooling fails closed, it emits a structured JSON error on stderr:

```json
{
  "ok": false,
  "error": "Project 'Dev Loop Queue' not found for owner 'mfittko'."
}
```

The stderr payload follows the repo's standard CLI error format (`formatCliError`):
`{ ok: false, error }` with an optional one-line `hint` (e.g. `"run with --help for usage"`)
when a usage string exists — the full usage text is never inlined into this JSON payload;
run the tool with `--help` for it. Remediation hints such as `code` keys or suggested
commands live in documentation, not in the structured stderr output.

## Column auto-repair

The bootstrap wrapper (`dev-loops project ensure`) performs automatic column repair
when the Status field exists but has non-standard columns. Instead of throwing, it calls
`updateProjectV2Field` to add missing standard columns (`Backlog`, `Next Up`, `In Progress`,
`Done`). Non-standard columns are left in place — only missing columns are added.

Auto-repair covers:
- Status field with a subset of standard columns (e.g. only `Backlog` and `Done`)
- Status field with entirely non-standard columns (e.g. `Todo`/`Doing`/`Done`)
- Status field with a mix of standard and non-standard columns

Auto-repair does NOT remove or rename existing columns. Column removal/reordering remains
a manual operation via the GitHub Projects UI.


## Rename-aware column repair

The bootstrap wrapper recognizes a bounded set of semantically equivalent Status column names and can reconcile them to the canonical four-column contract. For example, `Ready` is treated as equivalent to `Next Up`, and `Doing` as equivalent to `In Progress`.

### Default behavior

Without an explicit repair flag, the wrapper:

- Reports detected rename candidates in `repairs.renameCandidates`.
- Does **not** rename existing columns.
- Does **not** add a standard column that would duplicate an equivalent column already on the board.
- Still adds any standard columns that are missing and not covered by an equivalent.

### Authorized rename behavior

With `--repair-rename`, the wrapper:

- Renames recognized equivalent columns to the canonical standard names.
- Adds any remaining missing standard columns.
- Leaves unrecognized columns and item assignments untouched.

### Conflicts

<!-- rule: QUEUE-RENAME-CONFLICT-NO-MUTATION -->
When multiple existing columns map to the same standard column, the wrapper **MUST** report an irreconcilable conflict in `repairs.conflicts` and **MUST NOT** perform any mutation. The operator must resolve the ambiguity manually.

## Lifecycle status transitions

When a queue board is configured, the queue driver may optionally write bounded Status transitions back to the board. This is **opt-in** and **fail-open**: if the board is absent, misconfigured, or the GitHub API fails, the queue run continues and reports the sync problem in the result.

### Transition matrix

| Queue event | Default target Status | Configurable override | Notes |
|---|---|---|---|
| Item picked up by `runQueue` | `In Progress` | none | Fired after the entry transitions to `running`. |
| `runEntry` succeeds | `Done` | none | Fired when the entry reaches `done`. |
| `runEntry` throws (any failure) | `Backlog` | `queue.nonSuccessStatus` | Fired before the entry is marked `failed`/`blocked`. |

### Configuration

Board integration is active only when `.devloops` at repo root identifies a board:

```yaml
tracker:
  board:
    number: 5          # direct project number
    # OR title: "Dev Loop Queue"
queue:
  nonSuccessStatus: Backlog # optional fallback column for non-success outcomes
```

`tracker.board` is the preferred key; the deprecated `queue.board` (same shape) is still
honored as a fallback. If neither is set (no `number`, no `title`), no board transitions
are attempted and queue behavior is unchanged.

### Result shape

The queue driver returns a `boardSync` array on each entry result. Each element records one attempted transition:

```json
[
  {
    "ok": true,
    "skipped": false,
    "result": { "ok": true, "item": { "newColumn": "In Progress" } }
  },
  {
    "ok": true,
    "skipped": false,
    "result": { "ok": true, "item": { "newColumn": "Done" } }
  }
]
```

The inner `result.ok` / `result.item` shape is owned by the underlying `move-queue-item.mjs` script. When the board is not configured or the sync fails in fail-open mode, `skipped` is `true` and a `reason` explains why.

## Conductor board synchronization responsibility

<!-- rule: QUEUE-BOARD-SYNC-CONTINUOUS -->
When a queue board is configured, the conductor **MUST** keep the board synchronized with actual issue/PR state continuously — reconciling at each lifecycle transition and through periodic reconciliation — instead of waiting for a human to notice drift. This is the operating conductor's obligation, distinct from the queue driver's opt-in, fail-open automated Status writes in [Lifecycle status transitions](#lifecycle-status-transitions); it is normative for any conductor working the queue, including headless and cross-repository runs. Each trigger below has a required board effect:

| Trigger | Required board effect |
|---|---|
| File / enqueue an item for the queue | The item **MUST** be placed on a real column via `add-queue-item.mjs` — `--next-up` when it is refined and queued to work, `--column Backlog` when it is tracked but not yet prioritized (or not yet refined) — and **MUST NOT** be left off the board. Promotion into `Next Up` remains subject to [QUEUE-ENQUEUE-REFINEMENT-GATE](#queue-pickup-ordering). |
| Dispatch a runner on an item | The conductor **MUST** immediately set the item to `In Progress` via `move-queue-item.mjs --to-column "In Progress"` and **MUST** re-read the item to confirm the move landed rather than assuming the runner did it; an in-flight item **MUST NOT** stay outside `In Progress`. |
| Merge or close the item | The item **MUST** be in `Done`. |
| Reprioritize or block the item | The item's column **MUST** be updated to match: reprioritized items move between `Backlog` and `Next Up`, and a blocked item **MUST** be moved back to `Backlog`. The conductor **MUST NOT** promote an unrefined issue into `Next Up`, upholding the refinement bar of [QUEUE-ENQUEUE-REFINEMENT-GATE](#queue-pickup-ordering). |
| Periodic reconcile | The conductor **MUST** proactively enumerate board items with `list-queue-items.mjs`, compare each against the underlying issue/PR state, and correct any mismatch without being asked. |

The conductor **MUST** perform every board read and column mutation through the canonical projects scripts (`add-queue-item.mjs`, `move-queue-item.mjs`, `list-queue-items.mjs`); it **MUST NOT** hand-roll `gh api graphql` calls to synchronize the board. This rule governs the conductor's operational obligation to act; the column vocabulary it targets is owned by [QUEUE-COLUMN-CANONICAL](#conventional-columns), and the bootstrap-only structural-mutation boundary by [QUEUE-BOOTSTRAP-ONLY-MUTATOR](#idempotent-bootstrap-exception).

## Queue pickup ordering

<!-- rule: QUEUE-NEXTUP-SOURCE -->
When a queue board is configured, `Next Up` is the **normative, fail-closed pickup source** — not a soft hint. The driver **MUST** pick **only** from the `Next Up` column, by POSITION ascending, and **MUST NOT** auto-pull from Backlog or fall back to non-board local queue order under any circumstance.

### Behavior (board configured)

- The driver queries items in the `Next Up` column by POSITION ascending before the first dispatch, and dispatches **only** those items, in that order.
- An entry present in the local queue but **absent** from `Next Up` is **never** auto-picked. Working an item requires the deliberate prioritization step of moving it to `Next Up` first.
- <!-- rule: QUEUE-NEXTUP-EMPTY-FAIL-CLOSED --> **Empty `Next Up` (successful query, zero items) → fail closed.** The driver **MUST** idle/stop with an explicit, machine-readable outcome (`reason: "next-up-empty"`, message `"queue empty — prioritize Backlog items into Next Up"`) and **MUST NOT** fall back to Backlog or local order.
- <!-- rule: QUEUE-BOARD-QUERY-FAIL-CLOSED --> **Board-query error (API/unreachable/unresolvable project) → surface and stop.** The driver **MUST** surface the error and stop (`reason: "board-query-error"`) and **MUST NOT** fall back to Backlog or local order. This is deliberately distinct from an empty `Next Up`: an outage never silently drains Backlog.
- <!-- rule: QUEUE-NEXTUP-TARGET-MISSING-FAIL-CLOSED --> **`Next Up` target with no local queue entry → fail closed.** When the resolved `Next Up` order contains one or more targets absent from `.pi/dev-loop-queue.json` (membership reconcile not run/persisted, or the board changed between reconcile and this query), the driver **MUST** stop with an actionable outcome (`reason: "next-up-target-missing-locally"`, the offending numbers in `missingTargets`, message `"Next Up contains items with no local queue entry — run membership reconcile / re-add them"`) rather than silently filtering them out and returning an empty idle, and **MUST NOT** pick from Backlog. This is distinct from an empty `Next Up`: real Next Up work exists but is undispatchable locally.
- <!-- rule: QUEUE-ENQUEUE-REFINEMENT-GATE --> **An issue MUST carry a refinement artifact before it enters `Next Up`.** When an enqueue resolves the target to the pickup column (`queue add --next-up`, or `--column` naming it), it gates on the same check the draft gate uses (an Acceptance criteria section, a DoD section, or a linked refinement doc — see `detectIssueRefinementArtifact`), so an un-refined issue never lands in the pickup column in the first place. The gate is issue-only: a PR targeting the pickup column is not gated here (its spec-of-record is validated at the draft gate). Interactive enqueue **MUST** fail closed with `MISSING_REFINEMENT_ARTIFACT`, naming the missing sections. Headless (`--auto`) enqueue **MUST NOT** fail the run; it diverts the issue to the non-pickup park column (`nonSuccessBoardColumn`, which **MUST** differ from the pickup column) and records the diversion reason instead. Synthesizing the missing artifact (running the refiner / `loop-grill --auto`) is an **orchestration-layer** responsibility, not the board-mutation script's: the enqueue script enforces the gate and parks; the agent/command layer grills a parked issue and re-enqueues once refined. This shifts the check left; the draft gate remains the unconditional backstop for whatever slips through some other enqueue path.

### Live pickup path (`/dev-loops:loop-continue`)

<!-- rule: QUEUE-LIVE-PICKUP-SOURCE -->
Bare `/loop-continue` (in the dev-loops repo) / `/dev-loops:loop-continue` (in a consumer install) is the operator-facing pickup path; it **MUST** enforce the same `Next Up` normative source as the queue driver and **MUST NOT** pick from Backlog. It resolves a single continue target via `scripts/projects/resolve-active-board-item.mjs`:

- **Exactly one `In Progress` item →** continue it (`source: "in-progress"`).
- **Multiple `In Progress` items →** fail closed (never guesses); the operator must pass an explicit `/dev-loops:loop-continue #N` (or `/loop-continue #N` in the dev-loops repo itself).
- **Zero `In Progress` items →** fall through to the **HEAD of `Next Up` by POSITION ascending** (`source: "next-up"`).
  - **Empty `Next Up` →** fail closed (idle) with the canonical `"queue empty — prioritize Backlog items into Next Up"`. **No** Backlog pickup.
  - **`Next Up` query error →** surface and stop (fail closed). No fallback, no guessing.

The live path never pulls from Backlog and never picks more than one target. It resolves the concrete target and hands `continue dev loop on #<number>` to the dev-loop skill.

### Carve-outs

- **A single-issue/PR run never reaches this gating.** Running a specific `--issue`/`--pr` target goes through the dev-loop routing path, not the queue driver, so `Next Up` gating does not apply to it at all — it runs regardless of the board. The queue driver itself has no explicit-target flag; `Next Up` gating is unconditional for every item the driver picks.
- **No board configured.** When `.devloops` does not configure a board, there is no `Next Up` to gate on; the driver keeps its legacy local (topological/insertion) order.

### Limitation: default `Next Up` display name

The normative `Next Up` rule above currently assumes the **default** `Next Up` display name. Honoring a `queue.statusColumns.next_up` override (and its siblings `in_progress`/`done`) across the pickup-ordering and projects-script layer (`resolveNextUpOrder`, `queue add`, `queue list`, `queue move`) is **not yet implemented** — those layers key off the literal `Next Up`/`In Progress`/`Done` names even though board-sync respects `statusColumns`. Renaming the logical Next Up column via `statusColumns` is therefore not fully supported by this contract yet; that work is tracked in #1098.

### Example

```yaml
tracker:
  board:
    number: 5
```

With local queue entries `[#1, #2, #3]`, an entry `#4` that is **not** in `Next Up`, and board `Next Up` order `[#3, #1]`, the driver dispatches `#3` then `#1` and nothing else — `#2` and `#4` are left untouched. If `Next Up` is empty, the driver idles with `"queue empty — prioritize Backlog items into Next Up"` and never touches Backlog.
## Configuration shape

Queue board configuration lives under `.devloops` at repo root. All keys are optional;
the queue path works without a board.

```yaml
tracker:
  board:
    # GitHub Projects V2 project number for direct lookup (overrides title-based discovery).
    number: 1
    # Board title for Projects V2 lookup (used when number is not set).
    title: "Dev Loop Queue"

queue:
  # Maximum parallel entries the queue may process concurrently.
  maxParallel: 3

  # Maximum bug issues the queue driver may auto-file in one run.
  maxAutoFiledIssues: 10

  # Maximum retry attempts per entry for recoverable failures.
  reDispatchMaxRetries: 1

```

### Board title key

The board `title` key (under `tracker.board`, or the deprecated `queue.board`) is the primary opt-in signal for Projects-based queue ordering (`number` is also available — see Project number key below):

| Value | Meaning |
|---|---|
| Neither `tracker.board` nor `queue.board` set | Projects path not active; use positional ordering |
| `"Dev Loop Queue"` (recommended title) | Look up project by this title under the repo owner |
| Any other string | Look up project by that exact title |

If the board `title` is set but the project does not exist, queue operations that depend on board
ordering fail closed — they do not treat the missing board as equivalent to "not opted in."

### Project number key

The board `number` key provides direct project lookup by number, bypassing title-based
discovery. When both `number` and `title` are set on the same board entry, `number` takes precedence.

### Settings source

Queue board settings (`tracker.board` first, then the deprecated `queue.board`; `title` /
`number`) are read only from `.devloops` at the repo root. The queue tooling does not consult the shipped defaults
(`packages/core/src/config/extension-defaults.yaml`) or the repo-local
`.pi/dev-loop/defaults.*` override layer for them — both deliberately omit these keys.

Project number and URL are discoverable at runtime via the GraphQL API; per
`QUEUE-BOARD-DEVLOOPS-RESOLUTION`, commands resolve the board from the `.devloops` entry
when `--project` is omitted, so the config entry is how a repo opts into automatic
resolution.

## Required GraphQL operations

Helpers consume these minimal GraphQL operations:

| Operation | Purpose | Used by |
|---|---|---|
| `projectsV2` query (user/org) | List projects by owner, find by title | bootstrap, list, move, add, reorder |
| `createProjectV2` mutation | Create project board | bootstrap only |
| `createProjectV2Field` mutation | Create Status field with columns | bootstrap only |
| `linkProjectV2ToRepository` mutation | Link a project board to a repository | bootstrap only |
| `updateProjectV2Field` mutation | Add columns to an existing Status field | bootstrap auto-repair only |
| `fields` query (with `ProjectV2SingleSelectField`) | Read Status field + options | bootstrap, list, move, add |
| `items` query (with `orderBy` + `filterBy`) | List items in a column by POSITION | list, reorder |
| `updateProjectV2ItemFieldValue` mutation | Set Status on an item (move between columns) | move |
| `addProjectV2ItemById` mutation | Add an existing issue/PR to the project | add |
| `updateProjectV2ItemPosition` mutation | Reorder an item within/between columns | reorder |

## Non-goals

This contract explicitly does **not** define:

- **Full Kanban automation** — GitHub has built-in workflows for Status transitions. The
  queue helpers only read ordering and set Status; they do not react to Status changes.
- **Local persistence replacement** — Board state is an optional scheduling input. This
  contract introduces no new local queue file; it complements existing queue mode persistence.
- **Bi-directional sync** — the queue *tooling* does not run an automated background process
  that mirrors local state to board state or the reverse; it reads board ordering at dispatch
  time and writes Status on transitions. Keeping the board continuously reconciled with actual
  issue/PR state is instead the conductor's operator responsibility
  ([QUEUE-BOARD-SYNC-CONTINUOUS](#conductor-board-synchronization-responsibility)), carried
  out through the queue scripts rather than automated tooling.
- **Framework/library abstraction** — All helpers are thin wrappers around `gh api graphql`.
  No additional GraphQL client or abstraction layer is introduced.

## Relationship to queue mode

The queue-mode SPEC and [Setup](#setup) below
describe a queue-mode implementation that uses `.pi/dev-loop-queue.json` for durable entry
lifecycle tracking. This contract adds an **optional** Projects-board scheduling input on top
of that existing queue infrastructure — it does not replace local queue persistence and does
not introduce a second local queue file. When the board is not configured, queue ordering falls
back to positional arguments as described in the queue mode specification.

## Setup

One-time manual setup for the GitHub Projects V2 board that `dev-loops queue` helpers will read and write.

### Why a Projects V2 board?

The board provides durable, visible, shared state for queue ordering and item status — complementing the local queue persistence in `.pi/dev-loop-queue.json`. Board state is:

- **Durable** — survives CI restarts, local machine wipes, and session boundaries
- **Visible** — operators can inspect and reorder the queue from the GitHub UI
- **Authoritative for membership + ordering when configured** — when a board is configured (`tracker.board`, or the deprecated `queue.board`; `number` or `title`), `dev-loops queue run` reconciles the board's `Next Up` items into `.pi/dev-loop-queue.json` before running, so the board (not hand edits) drives **which** issues are worked and their order. Without a configured board, `dev-loops queue` falls back to the local queue file's entry order.

> Add work to the queue via the board (`dev-loops queue add ... --column "Next Up"`), not by hand-editing `.pi/dev-loop-queue.json`. With a populated board and an empty local queue, the runner reconciles the board's `Next Up` items in rather than reporting an empty queue. If a board is configured but `Next Up` is empty, the runner reports the canonical "queue empty — prioritize Backlog items into Next Up" (`reason: "next-up-empty"`) — distinct from the unconfigured-and-empty "Queue is empty".

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
[Conventional columns](#conventional-columns) above for the owning definition.

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

### How queue helpers use the board

Dev-loop queue wrappers will:

- **List** items from the board ordered by position
- **Add** new items to the `Backlog` column when issues are queued; promote to `Next Up` to enqueue them for the runner
- **Drive membership + ordering** from the board's `Next Up` column: `dev-loops queue run` reconciles `Next Up` items into queue entries before running (configured board is authoritative)
- **Move** items to `In Progress` when processing starts, `Done` when complete
- **Reorder** items when the operator adjusts priority via `--after` dependencies or manual intervention
- **Fall back** gracefully when the board is absent or unreachable: the local queue file's entry order takes over, and no board mutations are attempted

Use `dev-loops queue --help` to inspect the queue helper surface and per-subcommand `--help` for details.

### Status sync is driven by the loop state

The board **Status** column is kept in sync with the dev-loop's own state machine
rather than from hardcoded strings. A pure mapping
(`boardColumnForLoopState(loopState, mapping)` in
`packages/core/src/loop/queue-board-sync.mjs`) resolves each loop/lifecycle state
to a logical column, then to a configured display name.

#### State → logical column (defaults)

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

#### Configuring column names (opt-in)

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

#### No-op behavior

- **Board not configured / disabled** — sync returns `{ ok: true, skipped: true }`
  and performs no GitHub calls (AC2/AC6).
- **Item not on the board** — sync is a logged no-op (`{ ok: true, skipped: true }`),
  never an error, so a missing board item can never break the loop (AC4).

### Reordering board items

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

#### Dry run

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

### Archiving completed items

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


#### Repairing drifted Status columns

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

This renames recognized equivalents (for example `Ready` -> `Next Up`) and adds any still-missing standard columns. It never removes existing columns. Irreconcilable conflicts (for example both `Ready` and `Next` mapping to `Next Up`) fail closed per `QUEUE-RENAME-CONFLICT-NO-MUTATION` in the [Conflicts](#conflicts) section above.

#### Fail-closed behavior

Queue helpers never silently assume board state is correct — see the
[Fail-closed behavior](#fail-closed-behavior) table above for the situation/behavior/exit-code matrix.

### Configuration

Queue and board configuration both live under `.devloops` at repo root — see
[Configuration shape](#configuration-shape) above for the full `queue` keys
(`maxParallel`, `maxAutoFiledIssues`, `reDispatchMaxRetries`) and the `tracker.board` entry,
and `QUEUE-BOARD-DEVLOOPS-RESOLUTION` for how recording the board there lets every queue
command resolve it without `--project`.

## Usage

Practical operator's guide for using GitHub Projects V2 as an optional scheduling view for
`dev-loop` queue work day to day. See [Setup](#setup) above for one-time board bootstrap.

Board state is a human-readable scheduling hint layered on top of local queue persistence —
see [Why a Projects V2 board?](#why-a-projects-v2-board) above for the durability/visibility/
authority rationale. When a board **is** configured, `Next Up` is the authoritative,
fail-closed pickup source per [Queue pickup ordering](#queue-pickup-ordering). When **no**
board is configured, the queue falls back to its local entry order
(`.pi/dev-loop-queue.json`).

### How to opt in

The queue board resolves from `.devloops` (`tracker.board` / `queue.board`, by number or
title) in every operator-facing queue command; an explicit `--project <number|id>` overrides it.

First, bootstrap the board (one-time):

```sh
dev-loops queue ensure --repo <owner/name>
```

The wrapper emits the project number and URL. Record the board in `.devloops`
(`tracker.board` number or title) so subsequent helper invocations resolve it
automatically; `--project` remains available as an explicit override.

### How to use the helpers

Queue management lives under `dev-loops queue <subcommand>` (run `dev-loops queue --help` to
list them). `dev-loops project <subcommand>` is kept as a back-compat alias for the same
scripts. All helpers are thin wrappers around `gh api graphql`. They emit machine-readable JSON
on stdout and structured errors on stderr. All accept `--help` for usage.

#### List queue items

```sh
# List all items in a project
dev-loops queue list --repo mfittko/dev-loops --project 1

# List only items in "Next Up" column
dev-loops queue list --repo mfittko/dev-loops --project 1 --column "Next Up"

# Limit to top 5 items
dev-loops queue list --repo mfittko/dev-loops --project 1 --limit 5

# Human-readable board triage: aligned number/status/title columns
# (JSON stays the default; --table composes with --column/--limit)
dev-loops queue list --repo mfittko/dev-loops --project 1 --table
```

#### Add an item to the queue

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

#### Move an item between columns

```sh
# Move issue #42 from its current column to In Progress
dev-loops queue move --repo mfittko/dev-loops --project 1 --item 42 --to-column "In Progress"

# Move a project item by its node ID
dev-loops queue move --repo mfittko/dev-loops --project 1 --item "PVTI_..." --to-column "Done"
```

#### Reorder items

```sh
# Move issue #42 to the top of the column
dev-loops queue reorder --repo mfittko/dev-loops --project 1 --item 42

# Move issue #42 after issue #17
dev-loops queue reorder --repo mfittko/dev-loops --project 1 --item 42 --after 17

# Reorder by project item node IDs
dev-loops queue reorder --repo mfittko/dev-loops --project 1 --item "PVTI_abc" --after "PVTI_xyz"
```

#### Typical workflow

1. Bootstrap the board once: `dev-loops queue ensure --repo <owner/name>`
2. Add items as they are queued: `dev-loops queue add --repo ... --project <n> --item <issue>`
3. Reorder by priority: drag in the GitHub UI, or use `dev-loops queue reorder`
4. When a worker picks up an item: `dev-loops queue move ... --to-column "In Progress"`
5. When done: `dev-loops queue move ... --to-column "Done"`
6. Inspect the queue at any time: `dev-loops queue list ...`

### Fail-closed behavior

Every helper validates preconditions before mutating board state — see the
[Fail-closed behavior](#fail-closed-behavior) table above for the situation/behavior/
exit-code matrix.

#### Error format

On failure, helpers emit structured JSON on stderr:

```json
{"ok": false, "error": "Item #999 not found in project for repo \"owner/name\"", "code": "ITEM_NOT_FOUND"}
```

Exit codes:
- `1` — usage or argument error
- `2` — GitHub API error
- `3` — project, field, column, or item not found

#### Idempotent bootstrap exception

`QUEUE-BOOTSTRAP-ONLY-MUTATOR` (see [Idempotent bootstrap exception](#idempotent-bootstrap-exception) above)
applies here: `dev-loops project ensure` is the only helper allowed to **create** project
structure, and it safely re-runs — if the board and Status field already exist, it exits clean
with the existing project details.

### How dev-loop treats board state

When a board is **configured** (`queue.board.number` or `queue.board.title` in `.devloops`),
it is the **authoritative source of queue membership and ordering** — not just status.
`dev-loops queue run` resolves the board's `Next Up` column and reconciles those items into
`.pi/dev-loop-queue.json` (appending a queued entry for any `Next Up` issue not already
present) before running, then dispatches under `QUEUE-NEXTUP-SOURCE`. Enqueue work for
immediate pickup via `dev-loops queue add ... --next-up` rather than hand-editing the queue
file. See [Queue pickup ordering](#queue-pickup-ordering) for the
full fail-closed rule set (`QUEUE-NEXTUP-EMPTY-FAIL-CLOSED`, `QUEUE-BOARD-QUERY-FAIL-CLOSED`,
`QUEUE-NEXTUP-TARGET-MISSING-FAIL-CLOSED`) — an outage or an empty `Next Up` halts the run
rather than falling back to Backlog or local order. When **not** configured, the queue falls
back to its local entry order (`.pi/dev-loop-queue.json`), and the legacy "Queue is empty"
message applies when that file has no pending entries. The operator-facing live pickup path
(`/dev-loops:loop-continue`) enforces the same source; see
[Live pickup path](#live-pickup-path-dev-loopsloop-continue) above for the exact outcomes.

> **Limitation:** the normative `Next Up` rule (and `--next-up`, `queue add`/`list`/`move`)
> currently assumes the **default** `Next Up` display name. Renaming the logical column via
> `queue.statusColumns.next_up` (and siblings) is respected by board-sync but **not** yet by the
> ordering + projects-script layer, so a renamed Next Up column is not fully supported here.
> Honoring `statusColumns` across those layers is tracked in #1098.

#### Issue-less lightweight PRs on the board

An issue-less lightweight PR (`resolve-dev-loop-startup.mjs --lightweight` alone, per
[ARTIFACT-LIGHTWEIGHT-PLAN-FILE-EXCLUSIVE](./artifact-authority-contract.md#lightweight-pr-body-as-spec))
has no tracker issue, so it appears on the board as a **PR item only** — there is no
issue-backed board entry to reconcile or close for it.
`scripts/github/create-pr.mjs --lightweight` owns enqueuing that PR item on creation
(In Progress, on a board-configured repo); a tracker-backed PR never triggers this call.

#### Completion is reflected, never fabricated

The queue runner is a **deterministic adapter** over the board — it is **not** the orchestration
harness. It moves an item to **Done** (and marks the entry `done`) only as a reflection of a
**real terminal signal** supplied by an orchestrator (e.g. the item's linked PR merged), never as
a side effect of a resolve/run pass. When no orchestrator is wired into the current harness,
`dev-loops queue run` is a **no-op**: it leaves every board column unchanged and reports
`reason: "no-orchestrator"` rather than fabricating completion for unperformed work (#913).

## See also

- the queue-mode SPEC (`docs/specs/queue-mode/SPEC.md`) — full queue mode specification
- Issue [#625](https://github.com/mfittko/dev-loops/issues/625) — parent epic
- Issue [#626](https://github.com/mfittko/dev-loops/issues/626) — this contract refinement
- Issue [#627](https://github.com/mfittko/dev-loops/issues/627) — list helper
- Issue [#628](https://github.com/mfittko/dev-loops/issues/628) — move helper
- Issue [#629](https://github.com/mfittko/dev-loops/issues/629) — add helper
- Issue [#630](https://github.com/mfittko/dev-loops/issues/630) — reorder helper
- Issue [#631](https://github.com/mfittko/dev-loops/issues/631) — usage documentation
- Issue [#632](https://github.com/mfittko/dev-loops/issues/632) — board bootstrap
