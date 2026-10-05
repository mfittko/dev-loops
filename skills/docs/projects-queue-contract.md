# GitHub Projects Queue Contract

Canonical owner for the GitHub Projects V2 queue board contract: board shape, the Status
column vocabulary, and `Next Up` pickup rules. It also carries the one-time
[Setup](#setup) guide and the day-to-day [Usage](#usage) guide for the queue helpers.

## Purpose

When a dev-loop operator opts into the GitHub Projects queue path, queue helpers read queue
ordering from a project board and write status transitions back, relying on deterministic
field/column names and failing safely when the board is absent or misconfigured.

<!-- rule: QUEUE-BOARD-LINKED -->
**The queue board MUST be linked to the target repository** via `linkProjectV2ToRepository`.
User-level (unlinked) projects are not supported for queue ordering and must be migrated.

**Board state is an optional scheduling input; it does not replace GitHub issue/PR state as
the source of truth.** This contract introduces no new local queue file (see
[Relationship to queue mode](#relationship-to-queue-mode)).

## Opt-in posture

GitHub Projects is **optional**. Without a board, queue helpers fall back to positional
argument ordering. Setting up a board is a one-time operator action, not a startup requirement.

Tooling never mutates project/field structure without explicit operator invocation of the
bootstrap wrapper (`node <dev-loops-package-root>/cli/index.mjs queue ensure`; `node <dev-loops-package-root>/cli/index.mjs project ensure` is a back-compat
alias). Runtime queue operations only read/write item position and Status field values.

## Board identification

<!-- rule: QUEUE-BOARD-DEVLOOPS-RESOLUTION -->
Every operator-facing `scripts/projects/*` queue command **MUST** resolve the board from
`.devloops` (`tracker.board`; number or title) when `--project` is omitted; an explicit `--project` overrides. The structural halves
(the `applyDevloopsBoard` call and `projectTitle` delegation forwarding) are enforced by
`test/contracts/queue-board-resolution-contract.test.mjs`, which inspects commands that read
`--project`/`args.project` and exempts the `_resolve-project.mjs` helper itself and the board
bootstrap `ensure-queue-board.mjs`. Omitted-flag and override behaviors are covered
behaviorally where suites exist (`resolve-active-board-item`, `list-queue-items`); the
remaining siblings are covered structurally only.

### Owner and project

Tooling resolves the owner (user or organization) from the repository slug
(`--repo <owner/name>`, first component) and looks up the project among that owner's
Projects V2 instances. The recommended title is `"Dev Loop Queue"`; GitHub assigns the
project number on creation.

Project lookup is by **exact title match** against the configured title, over a paginated
`projectsV2` listing. If no project with the configured title exists, tooling fails closed;
it does not create a project silently.

## Required fields

The board must have a **Status** field of type `single-select`. It is the only required
field; all queue-state read/write operations key off Status. Tooling identifies the field by
name (`"Status"`) and uses its field ID and option IDs in item mutations.

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
match. The bootstrap wrapper creates these four columns. Operators may add additional
Status options.

<!-- rule: QUEUE-COLUMN-NO-REMOVE -->
Operators **MUST NOT remove or rename** the four conventional columns — tooling fails closed
when expected columns are missing.
The authorized `--repair-rename` path below restores recognized equivalents to the canonical
names; it does not rename a canonical column away.

## Queue ordering

Queue ordering is the GitHub Projects V2 item **POSITION** (ascending) within a
Status-filtered query (`items` with `orderBy: { field: POSITION, direction: ASC }` and a
Status `filterBy`). The operator sets it by drag-drop in the board UI or with the `reorder`
helper (`updateProjectV2ItemPosition`); tooling reads it and does not enforce its own order.
Ordering is **column-scoped**. `--limit N` takes the first N items of the ordered result.

### Listing lag

The whole-board `ProjectV2.items` listing can lag behind GitHub and leave out newly added
items for hours, so `list-queue-items` and the `reorder` before/after snapshot can miss them.
Tooling does not work around this. Move and reorder do not depend on the listing. A number
ref is looked up from the issue side (`issueOrPullRequest(number).projectItems`, filtered to
the configured project and to unarchived items). An item node ID ref is looked up with
`node(id)` and must belong to the configured project and repository. A lookup miss, a
project mismatch, a repository mismatch, or an archived item fails closed with
`ITEM_NOT_FOUND` (exit 3). A number lookup that finds the item on the configured project
succeeds even if the response also carries errors for other projects. Otherwise, any
GraphQL error other than `NOT_FOUND` fails as `GRAPHQL_ERROR` (exit 2).

## Fail-closed behavior

Tooling never silently assumes board state is correct. Every operation that depends on the
board validates preconditions first:

| Situation | Behavior | Exit code |
|---|---|---|
| No board configured (not opted in) | Fall back to positional ordering; no board mutations | N/A (normal) |
| Board not found by title | Operation fails; no fallback to creation | 3 |
| Board exists but Status field missing | Operation fails; manual reconciliation needed | 3 |
| Board exists but Status field missing expected column | Operation fails; manual reconciliation needed | 3 |
| GitHub API returns error | Operation fails; queue continues with next item | 2 |
| Item not found on board (move/add operation) | Operation fails; no silent creation | 3 |

### Idempotent bootstrap exception

<!-- rule: QUEUE-BOOTSTRAP-ONLY-MUTATOR -->
The `node <dev-loops-package-root>/cli/index.mjs queue ensure` bootstrap wrapper has relaxed fail-closed behavior: it
**creates** a missing project and/or Status field with conventional columns. It **MUST** be
the only tool that mutates project structure; runtime queue helpers (list, move, add,
reorder) **MUST NOT** create or modify project/field structure. It is safe to re-run: when
the board and Status field already exist, it exits clean with the existing project details.

### Error reporting

When tooling fails closed, it emits a structured JSON error on stderr in one of two shapes:

- **Domain error** (any error thrown from the command's `main`, including argument
  *validation* such as `INVALID_REPO`): `{ ok, error, code }`, and each helper's
  `classifyExitCode` maps the `code` to the exit status per [Error format](#error-format).
- **Argument-parse error** (exit 1, the `parseCliArgs` path): the standard
  `formatCliError` shape `{ ok, error }` with an optional one-line `hint` (e.g.
  `"run with --help for usage"`) and no `code`. An `INVALID_*` validation error from `main`
  also exits 1 but uses the domain envelope.

## Column auto-repair

When the Status field exists but has non-standard columns, `node <dev-loops-package-root>/cli/index.mjs queue ensure` calls
`updateProjectV2Field` to add missing standard columns (`Backlog`, `Next Up`, `In Progress`,
`Done`) instead of throwing. This covers a subset of standard columns, entirely
non-standard columns (e.g. `Todo`/`Doing`/`Done`), and a mix. Default auto-repair does NOT
remove or rename existing columns. Column removal/reordering remains a manual operation in
the GitHub Projects UI.

## Rename-aware column repair

The bootstrap wrapper recognizes a bounded set of semantically equivalent Status column names, for example `Ready` for `Next Up` and `Doing` for `In Progress`.

### Default behavior

Without an explicit repair flag, the wrapper:

- Reports detected rename candidates in `repairs.renameCandidates`.
- Does **not** rename existing columns.
- Does **not** add a standard column that would duplicate an equivalent column already on the board.
- Still adds any standard columns that are missing and not covered by an equivalent.

### Authorized rename behavior

With `--repair-rename` (`node <dev-loops-package-root>/cli/index.mjs queue ensure --repo <owner/name> --repair-rename`), after
the operator reviews the reported candidates, the wrapper:

- Renames recognized equivalent columns to the canonical standard names.
- Adds any remaining missing standard columns.
- Leaves unrecognized columns and item assignments untouched, and never removes a column.

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

Board integration is active only when `.devloops` at repo root identifies a board
(`tracker.board`, see [Configuration shape](#configuration-shape)). `queue.nonSuccessStatus`
optionally overrides the non-success column.

### Result shape

The queue driver returns a `boardSync` array on each entry result, one element per attempted
transition: `{ "ok": true, "skipped": false, "result": { "ok": true, "item": { "newColumn": "In Progress" } } }`.
`move-queue-item.mjs` owns the inner `result` shape. When the board is not configured or the
sync fails in fail-open mode, `skipped` is `true` and a `reason` explains why.

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

The conductor **MUST** perform every board read and column mutation through the canonical projects scripts (`add-queue-item.mjs`, `move-queue-item.mjs`, `list-queue-items.mjs`); it **MUST NOT** hand-roll `gh api graphql` calls to synchronize the board. The column vocabulary is owned by [QUEUE-COLUMN-CANONICAL](#conventional-columns), and the structural-mutation boundary by [QUEUE-BOOTSTRAP-ONLY-MUTATOR](#idempotent-bootstrap-exception).

## Queue pickup ordering

<!-- rule: QUEUE-NEXTUP-SOURCE -->
When a queue board is configured, `Next Up` is the **normative, fail-closed pickup source** — not a soft hint. The driver **MUST** pick **only** from the `Next Up` column, by POSITION ascending, and **MUST NOT** auto-pull from Backlog or fall back to non-board local queue order under any circumstance.

### Behavior (board configured)

- `node <dev-loops-package-root>/cli/index.mjs queue run` first reconciles the board's `Next Up` items into `.pi/dev-loop-queue.json` (appending a queued entry for any `Next Up` issue not already present). The driver then queries `Next Up` by POSITION ascending before the first dispatch, and dispatches **only** those items, in that order.
- An entry present in the local queue but **absent** from `Next Up` is **never** auto-picked. Working an item requires moving it to `Next Up` first.
- <!-- rule: QUEUE-NEXTUP-EMPTY-FAIL-CLOSED --> **Empty `Next Up` (successful query, zero items) → fail closed.** The driver **MUST** idle/stop with an explicit, machine-readable outcome (`reason: "next-up-empty"`, message `"queue empty — prioritize Backlog items into Next Up"`) and **MUST NOT** fall back to Backlog or local order.
- <!-- rule: QUEUE-BOARD-QUERY-FAIL-CLOSED --> **Board-query error (API/unreachable/unresolvable project) → surface and stop.** The driver **MUST** surface the error and stop (`reason: "board-query-error"`) and **MUST NOT** fall back to Backlog or local order. This is deliberately distinct from an empty `Next Up`: an outage never silently drains Backlog.
- <!-- rule: QUEUE-NEXTUP-TARGET-MISSING-FAIL-CLOSED --> **`Next Up` target with no local queue entry → fail closed.** When the resolved `Next Up` order contains one or more targets absent from `.pi/dev-loop-queue.json` (membership reconcile not run/persisted, or the board changed between reconcile and this query), the driver **MUST** stop with an actionable outcome (`reason: "next-up-target-missing-locally"`, the offending numbers in `missingTargets`, message `"Next Up contains items with no local queue entry — run membership reconcile / re-add them"`) rather than silently filtering them out and returning an empty idle, and **MUST NOT** pick from Backlog.
- <!-- rule: QUEUE-ENQUEUE-REFINEMENT-GATE --> **An issue MUST carry the refinement matrix before it enters `Next Up`.** When an enqueue resolves the target to the pickup column (`queue add --next-up`, or `--column` naming it), it gates on the check the draft gate uses: `ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR` in [Artifact Authority Contract](artifact-authority-contract.md) (`detectIssueRefinementArtifact`). A linked refinement doc (`tmp/refinement/*.md`) remains a complete artifact on its own. A checklist-only or matrix-missing issue blocks with `missing_ac_dod_matrix`, an empty/identifier-only matrix with `malformed_ac_dod_matrix`, and a matrix without an explicit Non-goals section with `missing_explicit_non_goals`, each with guidance naming the missing/invalid artifact. The gate is issue-only: a PR targeting the pickup column is validated at the draft gate instead. Interactive enqueue **MUST** fail closed with `MISSING_REFINEMENT_ARTIFACT`, naming the missing sections. Headless (`--auto`) enqueue **MUST NOT** fail the run; it diverts the issue to the non-pickup park column (`nonSuccessBoardColumn`, which **MUST** differ from the pickup column) and records the diversion reason instead. The enqueue script enforces the gate and parks; the orchestration layer grills a parked issue (refiner / `loop-grill --auto`) and re-enqueues once refined. The draft gate remains the unconditional backstop for other enqueue paths.

### Live pickup path (`/dev-loops:loop-continue`)

<!-- rule: QUEUE-LIVE-PICKUP-SOURCE -->
Bare `/loop-continue` (in the dev-loops repo) / `/dev-loops:loop-continue` (in a consumer install) is the operator-facing pickup path; it **MUST** enforce the same `Next Up` normative source as the queue driver and **MUST NOT** pick from Backlog. It resolves a single continue target via `scripts/projects/resolve-active-board-item.mjs`:

- **Exactly one `In Progress` item →** continue it (`source: "in-progress"`).
- **Multiple `In Progress` items →** fail closed (never guesses); the operator must pass an explicit `/dev-loops:loop-continue #N` (or `/loop-continue #N` in the dev-loops repo itself).
- **Zero `In Progress` items →** fall through to the **HEAD of `Next Up` by POSITION ascending** (`source: "next-up"`).
  - **Empty `Next Up` →** fail closed (idle) with the canonical `"queue empty — prioritize Backlog items into Next Up"`. **No** Backlog pickup.
  - **`Next Up` query error →** surface and stop (fail closed). No fallback, no guessing.

The live path never picks more than one target. It hands `continue dev loop on #<number>` to the dev-loop skill.

### Carve-outs

- **A single-issue/PR run never reaches this gating.** A specific `--issue`/`--pr` target goes through the dev-loop routing path, not the queue driver, so `Next Up` gating does not apply to it. The queue driver has no explicit-target flag; `Next Up` gating is unconditional for every item the driver picks.
- **No board configured.** The driver keeps its local (topological/insertion) order from `.pi/dev-loop-queue.json`, and the legacy "Queue is empty" message applies when that file has no pending entries.

### Limitation: default `Next Up` display name

The normative `Next Up` rule above currently assumes the **default** `Next Up` display name. Honoring a `queue.statusColumns.next_up` override (and its siblings `in_progress`/`done`) across the pickup-ordering and projects-script layer (`resolveNextUpOrder`, `queue add`, `queue list`, `queue move`) is **not yet implemented** — those layers key off the literal `Next Up`/`In Progress`/`Done` names even though board-sync respects `statusColumns`. Renaming the logical Next Up column via `statusColumns` is therefore not fully supported by this contract yet; that work is tracked in #1098.

### Example

With a configured board, local queue entries `[#1, #2, #3]`, an entry `#4` that is **not** in `Next Up`, and board `Next Up` order `[#3, #1]`, the driver dispatches `#3` then `#1` and nothing else. If `Next Up` is empty, the driver idles with `"queue empty — prioritize Backlog items into Next Up"` and never touches Backlog.

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

  # Optional fallback column for non-success outcomes.
  nonSuccessStatus: Backlog
```

- `tracker.board` is the only board key and the opt-in signal. The former `queue`-section
  board alias was removed at the v1.0.0 cut (ADR 0017). With no `number` and no `title`, the
  Projects path is inactive: positional ordering applies and no board transitions run.
- `title` looks up the project by exact title under the repo owner. `number` looks it up
  directly and takes precedence when both are set.
- When a board is set but the project does not exist, queue operations that depend on board
  ordering fail closed; a missing board is not equivalent to "not opted in".
- Board settings are read only from `.devloops` at the repo root. The shipped defaults
  (`packages/core/src/config/extension-defaults.yaml`) and the repo-local
  `.pi/dev-loop/defaults.*` layer deliberately omit these keys.

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
| `items` query (with `orderBy` + `filterBy`) | List items in a column by POSITION | list, reorder (before/after snapshot only) |
| `issueOrPullRequest` query (with `projectItems`) | Find an item by issue/PR number | move, reorder |
| `node` query (as `ProjectV2Item`) | Find an item by item node ID and verify its project and repository | move, reorder |
| `updateProjectV2ItemFieldValue` mutation | Set Status on an item (move between columns) | move |
| `addProjectV2ItemById` mutation | Add an existing issue/PR to the project | add |
| `updateProjectV2ItemPosition` mutation | Reorder an item within/between columns | reorder |

## Non-goals

This contract explicitly does **not** define:

- **Full Kanban automation** — the queue helpers only read ordering and set Status; they do
  not react to Status changes.
- **Local persistence replacement** — no new local queue file.
- **Bi-directional sync** — the queue *tooling* runs no background process that mirrors
  local state to board state or the reverse. Continuous reconciliation is the conductor's
  responsibility ([QUEUE-BOARD-SYNC-CONTINUOUS](#conductor-board-synchronization-responsibility)).
- **Framework/library abstraction** — all helpers are thin wrappers around `gh api graphql`.

## Relationship to queue mode

The queue-mode SPEC (`docs/specs/queue-mode/SPEC.md`) uses `.pi/dev-loop-queue.json` for
durable entry lifecycle tracking. This contract adds an **optional** Projects-board scheduling
input on top of it. When no board is configured, queue ordering falls back to positional
arguments as the SPEC describes.

## Setup

One-time setup for the board that `dev-loops queue` helpers read and write. When configured,
the board is **authoritative for queue membership and ordering**, not just status (see
[Queue pickup ordering](#queue-pickup-ordering)). Add work through the board, not by
hand-editing `.pi/dev-loop-queue.json`.

### 1. Create the project board

Run the idempotent bootstrap wrapper:

```sh
node <dev-loops-package-root>/cli/index.mjs queue ensure --repo mfittko/dev-loops
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

Use `--title "My Queue"` for a custom title. Record the board in `.devloops`
(`tracker.board` number or title) so later helper invocations resolve it without
`--project` (`QUEUE-BOARD-DEVLOOPS-RESOLUTION`).

### 2. Verify the Status field

Open the project URL from the wrapper output and confirm the Status field has the four
canonical columns (`QUEUE-COLUMN-CANONICAL`, [Conventional columns](#conventional-columns)).

### 3. Manual setup alternative

To create the board manually via GitHub UI:

1. Go to your GitHub profile → **Projects** tab
2. Click **New project**
3. Select **Board** layout
4. Name it "Dev Loop Queue"
5. Add a **Status** field (type: Single select)
6. Add options: `Backlog`, `Next Up`, `In Progress`, `Done`
7. Record the project number from the URL: `https://github.com/users/<owner>/projects/<number>`

After manual creation, the wrapper's idempotent re-run detects the existing board and Status field and emits the same machine-readable JSON payload.

### Status sync is driven by the loop state

The board **Status** column follows the dev-loop's own state machine. A pure mapping
(`boardColumnForLoopState(loopState, mapping)` in
`packages/core/src/loop/queue-board-sync.mjs`) resolves each loop/lifecycle state
to a logical column, then to a configured display name.

#### State → logical column (defaults)

| Loop / lifecycle state | Logical column | Default display name |
| --- | --- | --- |
| `issue_opened`, `issue_intake`, `refinement`, `no_pr` | `next_up` | **Next Up** |
| `pr_draft`, `implementation`, `local_implementation_active`, `pr_ready_no_feedback`, `waiting_for_copilot_review`, `ready_to_rerequest_review`, `unresolved_feedback_present`, `already_fixed_needs_reply_resolve`, `waiting_for_ci`, `blocked_needs_user_decision`, other in-flight states | `in_progress` | **In Progress** |
| `final_approval_ready`, `pre_approval_gate` | `ready_for_review` | **In Progress** (unless overridden, see below) |
| `merged`, `issue_closed`, `done`, `merge` | `done` | **Done** |
| _any unmapped state_ | `in_progress` | **In Progress** (safe default) |

The mapping is **stateless**: it depends only on the current state, so a reverted state
moves the column backward (a reopened merged PR maps back from **Done** to **In Progress**).
An open draft PR (`pr_draft`) stays **In Progress**; the item returns to **Next Up** only
when it reverts to a pre-PR state (`no_pr`). No "furthest reached" column is persisted.

#### Configuring column names (opt-in)

Both overrides live under the opt-in `queue` section in `.devloops`; board sync itself is
enabled by a configured board (`tracker.board`). When no board is configured or sync is
disabled, status sync is a **no-op** with **no GitHub API calls and no board mutations**.

`queue.statusColumns` renames the display name of a logical column:

```yaml
tracker:
  board:
    number: 7
queue:
  statusColumns:
    next_up: "Todo"
    in_progress: "Doing"
    ready_for_review: "Ready for Review"   # opt-in column; otherwise final_approval_ready stays "In Progress"
    done: "Shipped"
```

`queue.stateColumnMap` remaps an individual loop state to a different logical
column (rarely needed):

```yaml
tracker:
  board:
    number: 7
queue:
  stateColumnMap:
    blocked_needs_user_decision: next_up
```

#### No-op behavior

- **Board not configured / disabled** — sync returns `{ ok: true, skipped: true }`
  and performs no GitHub calls (AC2/AC6).
- **Item not on the board** — sync is a logged no-op (`{ ok: true, skipped: true }`),
  never an error, so a missing board item can never break the loop (AC4).

### Reordering board items

`node <dev-loops-package-root>/cli/index.mjs queue reorder` wraps the `updateProjectV2ItemPosition` mutation. In
addition to the flag form (`--item [--after]`), it exposes three
subcommands. A `<ref>` is an issue/PR **number** or a project **item node ID**,
and every form works for both issues and PRs.

```sh
# Move issue/PR #630 to the top of its current Status column
node <dev-loops-package-root>/cli/index.mjs queue reorder move-to-top 630 --repo mfittko/dev-loops --project 1

# Move #630 immediately after #625
node <dev-loops-package-root>/cli/index.mjs queue reorder move-after 630 625 --repo mfittko/dev-loops --project 1

# Set an explicit order: 103 first, then 101, then 102
node <dev-loops-package-root>/cli/index.mjs queue reorder order 103 101 102 --repo mfittko/dev-loops --project 1
```

The subcommand forms emit JSON with the resolved `item`, `after_ref`, and the column order
`before` and `after` the change. Each snapshot entry carries `itemId`, `issueNumber`,
`prNumber` (one of the latter two is `null`), and `status`. `order` returns a `moves` array
(one entry per chained position mutation) plus the same `before`/`after` snapshots.

> **`order` is not atomic.** It applies N sequential `updateProjectV2ItemPosition`
> mutations with no rollback. If it fails partway, the board is left partially
> reordered and the thrown error reports how many moves completed (for example
> `order partially applied: 1 of 3 moves completed`). Re-running the **same**
> `order <ref1> <ref2> ...` command is idempotent and is the supported recovery
> path.

Add `--dry-run` to any form to print the intended GraphQL mutation(s), including the chained
mutations for `order`, without executing them. The output is `{ ok, dryRun: true, mutations,
before }`; the flag form returns the same shape with a single mutation.

A ref that does not resolve to an item in the target Project fails closed with
`ITEM_NOT_FOUND` (exit code 3).

### Archiving completed items

`node <dev-loops-package-root>/cli/index.mjs queue archive-done` archives items (via `archiveProjectV2Item`) whose issue or PR
has been **closed** for at least the given duration, regardless of their Status column. It is
operator-triggered (no webhooks) and scoped to the single repo passed via `--repo`.

```sh
# Archive items whose issue/PR closed more than 30 days ago (default)
node <dev-loops-package-root>/cli/index.mjs queue archive-done --repo mfittko/dev-loops --project 1

# Custom threshold (units: h = hours, d = days, w = weeks)
node <dev-loops-package-root>/cli/index.mjs queue archive-done --repo mfittko/dev-loops --project 1 --older-than 7d

# Preview without mutating
node <dev-loops-package-root>/cli/index.mjs queue archive-done --repo mfittko/dev-loops --project 1 --dry-run
```

The output reports `ok`, `olderThan`, `scanned` (the integer count of all board items of
the repo, including open, closed and archived), `archivable` (the integer count of the
closed-duration subset), and `archived` (one entry per archived item; each entry carries
`itemId`, `issueNumber`, `prNumber`, `closedAt`). A `--dry-run` result carries
`dryRun: true` and `mutations` (the planned archive mutations) and has no `archived`
field. Open items (even in the `Done` column) and already-archived items
are never touched.

## Usage

Day-to-day guide for the queue helpers. Queue management lives under
`dev-loops queue <subcommand>` (`node <dev-loops-package-root>/cli/index.mjs queue --help`); `dev-loops project <subcommand>` is
a back-compat alias. Helpers emit machine-readable JSON on stdout and structured errors on
stderr, and accept `--help`. The board resolves from `.devloops` per
`QUEUE-BOARD-DEVLOOPS-RESOLUTION`; `--project <number|id>` overrides it.

#### List queue items

```sh
# List all items in a project
node <dev-loops-package-root>/cli/index.mjs queue list --repo mfittko/dev-loops --project 1

# List only items in "Next Up" column
node <dev-loops-package-root>/cli/index.mjs queue list --repo mfittko/dev-loops --project 1 --column "Next Up"

# Limit to top 5 items
node <dev-loops-package-root>/cli/index.mjs queue list --repo mfittko/dev-loops --project 1 --limit 5

# Human-readable board triage: aligned number/status/title columns
# (JSON stays the default; --table composes with --column/--limit)
node <dev-loops-package-root>/cli/index.mjs queue list --repo mfittko/dev-loops --project 1 --table
```

#### Add an item to the queue

```sh
# Add issue #42 to the Backlog column (default = unprioritized intake).
# Backlog items are NEVER auto-picked; promote to Next Up to schedule them.
node <dev-loops-package-root>/cli/index.mjs queue add --repo mfittko/dev-loops --project 1 --item 42

# Enqueue for immediate work: land directly in Next Up (the normative pickup
# queue). --next-up is sugar for --column "Next Up".
node <dev-loops-package-root>/cli/index.mjs queue add --repo mfittko/dev-loops --project 1 --item 42 --next-up

# Add issue #42 to a specific column (--status is a back-compat alias for --column)
node <dev-loops-package-root>/cli/index.mjs queue add --repo mfittko/dev-loops --project 1 --item 42 --column "Next Up"
```

#### Move an item between columns

```sh
# Move issue #42 from its current column to In Progress
node <dev-loops-package-root>/cli/index.mjs queue move --repo mfittko/dev-loops --project 1 --item 42 --to-column "In Progress"

# Move a project item by its node ID
node <dev-loops-package-root>/cli/index.mjs queue move --repo mfittko/dev-loops --project 1 --item "PVTI_..." --to-column "Done"
```

#### Reorder items

```sh
# Move issue #42 to the top of the column
node <dev-loops-package-root>/cli/index.mjs queue reorder --repo mfittko/dev-loops --project 1 --item 42

# Move issue #42 after issue #17
node <dev-loops-package-root>/cli/index.mjs queue reorder --repo mfittko/dev-loops --project 1 --item 42 --after 17

# Reorder by project item node IDs
node <dev-loops-package-root>/cli/index.mjs queue reorder --repo mfittko/dev-loops --project 1 --item "PVTI_abc" --after "PVTI_xyz"
```

#### Error format

On failure, helpers emit structured JSON on stderr:

```json
{"ok": false, "error": "Item #999 not found in project \"<title>\" for repo \"owner/name\"", "code": "ITEM_NOT_FOUND"}
```

Exit codes (from each helper's `classifyExitCode`):
- `1` — usage or argument error (`INVALID_*`)
- `2` — GitHub API error (the default for an unmapped `code`)
- `3` — project, field, column, or item not found (`*_NOT_FOUND`)
- `4` — refinement gate: an enqueue into the pickup column with no AC/DoD matrix
  (`MISSING_REFINEMENT_ARTIFACT`, `add`/`move` only — see [QUEUE-ENQUEUE-REFINEMENT-GATE](#queue-pickup-ordering))

#### Issue-less lightweight PRs on the board

An issue-less lightweight PR (`resolve-dev-loop-startup.mjs --lightweight` alone, per
[ARTIFACT-LIGHTWEIGHT-PLAN-FILE-EXCLUSIVE](./artifact-authority-contract.md#lightweight-pr-body-as-spec))
has no tracker issue, so it appears on the board as a **PR item only**.
`scripts/github/create-pr.mjs --lightweight` owns enqueuing that PR item on creation
(In Progress, on a board-configured repo); a tracker-backed PR never triggers this call.

#### Completion is reflected, never fabricated

The queue runner is a **deterministic adapter** over the board, not the orchestration
harness. It moves an item to **Done** (and marks the entry `done`) only as a reflection of a
**real terminal signal** supplied by an orchestrator (e.g. the item's linked PR merged). When
no orchestrator is wired into the current harness, `node <dev-loops-package-root>/cli/index.mjs queue run` is a **no-op**: it
leaves every board column unchanged and reports `reason: "no-orchestrator"` (#913).

## See also

- the queue-mode SPEC (`docs/specs/queue-mode/SPEC.md`) — full queue mode specification
- Issue [#625](https://github.com/mfittko/dev-loops/issues/625) — parent epic
