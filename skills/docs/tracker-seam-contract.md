# Tracker Seam Contract

Canonical owner for the `Tracker` provider interface/registry (issue #1408,
the tracker-agnostic seam) — the generic seam the loop reads issues and
drives the queue/board through. GitHub is the first, baked-in, default
provider; this doc also covers how a consumer registers an external provider.

This is a **seam-shape** contract (which artifact type a run is bound to; see
[Artifact Authority Contract](artifact-authority-contract.md)) — orthogonal.

## Scope

**In scope:** issues (the spec of record) and the board/queue.

**Out of scope:** the PR/VCS-host surface — PRs, review threads, CI, Copilot
review. That surface stays GitHub-coupled.
`scripts/github/request-copilot-review.mjs`, `probe-copilot-review.mjs`, and
every gate-review/PR-lifecycle tool are unaffected by the tracker provider.

## The `Tracker` interface

Two capability groups, mirroring the existing harness-adapter idiom
(`packages/core/src/harness/`):

- **Issues (required)** — every provider implements these:
  `parseRef`, `getIssue`, `createIssue`, `editIssue`, `commentIssue`,
  `listIssues`, `detectLinkedPr`.
- **Board (optional capability)** — present only when the provider has a
  board/queue: `ensureBoard`, `listQueueItems`, `addQueueItem`,
  `setItemStatus`, `reorderItem`, `archiveItems`.

Implementation: `packages/core/src/tracker/`
- `adapter.mjs` — `createTrackerAdapter(impl)` validates the Issues
  REQUIRED_METHODS and freezes the result; `isTrackerAdapter()`;
  `hasBoardCapability()`.
- `github-adapter.mjs` — `createGithubTrackerAdapter()`, the v1 built-in
  reference implementation (a facade over the existing `gh` issue calls,
  now `packages/core/src/github/issue-ops.mjs`). It is a full Issues
  provider but only PARTIAL Board: `listQueueItems`/`setItemStatus` are
  wired (from `packages/core/src/projects/*.mjs`). `ensureBoard`/`addQueueItem`/
  `reorderItem`/`archiveItems` live only as `scripts/projects/*.mjs` CLI tools
  and are NOT wired into the adapter, because `packages/core` must not import
  from repo-root `scripts/`. `hasBoardCapability()` is therefore `false` for
  the built-in github adapter.
- `noop-adapter.mjs` — `createNoopTrackerAdapter()`, for tests.
- `index.mjs` — `resolveTrackerAdapter(config, deps?)`, the provider registry.

Exported from `@dev-loops/core/tracker`.

## Config

```yaml
# .devloops
tracker:
  provider: github              # registry key; default. External: provider + plugin (see below)
  board:                        # GitHub Projects board identifier
    title: "My Queue"
queue:
  statusColumns:                 # the github provider's logical-column -> Status mapping
    next_up: "Next Up"           # the fail-closed PICKUP column resolve-active-board-item.mjs reads
    in_progress: "In Progress"
    ready_for_review: "In Progress"
    done: "Done"
strategy: tracker-first          # renamed from "github-first" (still accepted, deprecated)
```

- `tracker.provider` defaults to `"github"` when unset.
- `tracker.board` is the canonical (and only) board config key. The former
  `queue`-section board alias was removed at the v1.0.0 cut (ADR 0017) — it no
  longer resolves a board (see `resolveTrackerBoard` in
  `packages/core/src/config/config.mjs`).
- **No `tracker.fieldMappings` key.** The github provider's logical-column ->
  Status mapping is `queue.statusColumns` (read by `loadStateColumnMap` in
  `packages/core/src/loop/queue-board-sync.mjs`, keyed by the
  `LOGICAL_COLUMN` values `next_up`, `in_progress`, `ready_for_review` and
  `done`; unset keys fall back to `DEFAULT_STATE_COLUMN_NAMES`).
- `strategy: "tracker-first"` renames the former `"github-first"`.
  `loadDevLoopConfig` still accepts `"github-first"` and normalizes it to
  `"tracker-first"` (with a load-time warning) BEFORE that layer's schema
  validation runs. The schema enum (`schemas/dev-loop-config.schema.json`)
  lists only `"tracker-first"`. See `ARTIFACT-STRATEGY-ENUM-FAIL-CLOSED` in
  [Artifact Authority Contract](artifact-authority-contract.md).

## Adding a tracker plugin (post-1.0)

Registering a provider is a drop-in against the stable `Tracker` interface
above — no core changes needed:

1. Implement the Issues capability (and Board, if the provider has one)
   against the shapes documented in `packages/core/src/tracker/adapter.mjs`.
   Wrap it with `createTrackerAdapter(impl)` so it is validated and frozen
   the same way the built-in GitHub provider is.
2. Register it with `resolveTrackerAdapter`:
   ```js
   import { resolveTrackerAdapter } from "@dev-loops/core/tracker";
   import { createJiraTrackerAdapter } from "@acme/devloops-jira";

   const tracker = resolveTrackerAdapter(config, {
     providers: { github: createGithubTrackerAdapter, jira: createJiraTrackerAdapter },
   });
   ```
3. Point `.devloops` at it: `tracker: { provider: "jira" }`.

`resolveTrackerAdapter` takes the effective config as a plain parameter and
holds no global/singleton state.

## Non-goals (v1)

- **Implementing an external tracker** (Jira/Shortcut/Linear/…). None ships here.
- **Multi-tracker-per-repo.** `.devloops` loads as a fixed layer stack at the
  repo root, so there is one effective config and one tracker per repo. The
  seam must not preclude per-scope config resolution or a `trackers:` routing
  map later, so `resolveTrackerAdapter` stays config-driven with no global
  singleton.
- **Capability-split / hybrid trackers** (e.g. GitHub for code/PRs, an
  external tracker for issues+board). Exactly one provider resolves one
  adapter per repo. The capability grouping (Issues vs Board) leaves room for
  a composite adapter and `issues.provider`/`board.provider` sugar later.
- **A generic/tracker-owned field-mapping key, or provider auto-discovery.**
  A second provider defines its own mapping shape when it exists.
- **The PR/VCS-host seam** (see Scope above).

## Relationship to other docs

| Doc | Relationship |
|---|---|
| [Artifact Authority Contract](artifact-authority-contract.md) | Defines which artifact is canonical (tracker-first / local-planning / lightweight); this doc defines which *provider* backs "tracker issue" |
| [Tracker-First Story-to-PR Contract](tracker-first-loop-state.md) | PR-level state machine for tracker-driven PRs; provider-agnostic already (a plugin emits a raw state string the core normalizer understands) |
| [Projects Queue Contract](./projects-queue-contract.md) | The GitHub Projects board contract the built-in `github` provider's Board capability wraps |
