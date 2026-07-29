# GitHub Projects Queue Contract

Canonical owner for the GitHub Projects V2 queue board contract: board shape, the Status
column vocabulary, and `Next Up` pickup rules. [Queue Board Setup](./queue-board-setup.md)
and [Projects Queue Usage](./projects-queue-usage.md) reference this contract's rules by ID
rather than restating them.

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
`.devloops` (`tracker.board` / `queue.board`, number or title) when `--project` is omitted;
an explicit `--project` overrides. The structural halves (the `applyDevloopsBoard` call and
`projectTitle` delegation forwarding) are enforced by
`test/contracts/queue-board-resolution-contract.test.mjs` (exempt: the board bootstrap
`ensure-queue-board.mjs`, which carries its own inline fallback); the omitted-flag and
override behaviors are covered by the per-script behavioral tests.

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
`{ ok: false, error }` with an optional `usage` field when available. Remediation hints
such as `code` keys or suggested commands live in documentation, not in the structured
stderr output.

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
queue:
  board:
    number: 5          # direct project number
    # OR title: "Dev Loop Queue"
  nonSuccessStatus: Backlog # optional fallback column for non-success outcomes
```

If `queue.board` is not set (neither `number` nor `title`), no board transitions are attempted and queue behavior is unchanged.

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

### Live pickup path (`/loop-continue`)

<!-- rule: QUEUE-LIVE-PICKUP-SOURCE -->
Bare `/loop-continue` is the operator-facing pickup path; it **MUST** enforce the same `Next Up` normative source as the queue driver and **MUST NOT** pick from Backlog. It resolves a single continue target via `scripts/projects/resolve-active-board-item.mjs`:

- **Exactly one `In Progress` item →** continue it (`source: "in-progress"`).
- **Multiple `In Progress` items →** fail closed (never guesses); the operator must pass an explicit `/loop-continue #N`.
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
queue:
  board:
    number: 5
```

With local queue entries `[#1, #2, #3]`, an entry `#4` that is **not** in `Next Up`, and board `Next Up` order `[#3, #1]`, the driver dispatches `#3` then `#1` and nothing else — `#2` and `#4` are left untouched. If `Next Up` is empty, the driver idles with `"queue empty — prioritize Backlog items into Next Up"` and never touches Backlog.
## Configuration shape

Queue board configuration lives under `.devloops` at repo root. All keys are optional;
the queue path works without a board.

```yaml
queue:
  # Maximum parallel entries the queue may process concurrently.
  maxParallel: 3

  board:
    # GitHub Projects V2 project number for direct lookup (overrides title-based discovery).
    number: 1
    # Board title for Projects V2 lookup (used when number is not set).
    title: "Dev Loop Queue"

  # Maximum bug issues the queue driver may auto-file in one run.
  maxAutoFiledIssues: 10

  # Maximum retry attempts per entry for recoverable failures.
  reDispatchMaxRetries: 1

```

### Board title key

The `queue.board.title` key is the primary opt-in signal for Projects-based queue ordering (`queue.board.number` is also available — see Project number key below):

| Value | Meaning |
|---|---|
| `queue.board` not set | Projects path not active; use positional ordering |
| `"Dev Loop Queue"` (recommended title) | Look up project by this title under the repo owner |
| Any other string | Look up project by that exact title |

If `queue.board.title` is set but the project does not exist, queue operations that depend on board
ordering fail closed — they do not treat the missing board as equivalent to "not opted in."

### Project number key

The `queue.board.number` key provides direct project lookup by number, bypassing title-based
discovery. When both `number` and `title` are set under `queue.board`, `number` takes precedence.

### Settings source

Queue board settings (`queue.board.title` / `queue.board.number`) are read only from `.devloops` at the
repo root. The queue tooling does not consult the shipped defaults
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

The queue-mode SPEC and [Queue Board Setup](./queue-board-setup.md)
describe a queue-mode implementation that uses `.pi/dev-loop-queue.json` for durable entry
lifecycle tracking. This contract adds an **optional** Projects-board scheduling input on top
of that existing queue infrastructure — it does not replace local queue persistence and does
not introduce a second local queue file. When the board is not configured, queue ordering falls
back to positional arguments as described in the queue mode specification.

## See also

- [Queue Board Setup](./queue-board-setup.md) — one-time setup guide
- the queue-mode SPEC (`docs/specs/queue-mode/SPEC.md`) — full queue mode specification
- Issue [#625](https://github.com/mfittko/dev-loops/issues/625) — parent epic
- Issue [#626](https://github.com/mfittko/dev-loops/issues/626) — this contract refinement
