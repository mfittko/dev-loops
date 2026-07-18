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
review. That surface stays GitHub-coupled; it is a separate, orthogonal
concern (a future, independent seam if a non-GitHub PR host is ever wanted).
`scripts/github/request-copilot-review.mjs`, `probe-copilot-review.mjs`, and
every gate-review/PR-lifecycle tool are unaffected by the tracker provider —
Copilot reviews GitHub PRs regardless of which tracker owns the issue.

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
  wired (the two board primitives already extracted to
  `packages/core/src/projects/*.mjs`); `ensureBoard`/`addQueueItem`/
  `reorderItem`/`archiveItems` still live only as `scripts/projects/*.mjs`
  CLI tools and are NOT (yet) wired into the adapter — `packages/core` must
  not import from repo-root `scripts/`. `hasBoardCapability()` is therefore
  `false` for the built-in github adapter; those four writers stay on their
  existing direct `gh`/CLI path, unaffected by this seam.
- `noop-adapter.mjs` — `createNoopTrackerAdapter()`, for tests.
- `index.mjs` — `resolveTrackerAdapter(config, deps?)`, the provider registry.

Exported from `@dev-loops/core/tracker`.

## Config

```yaml
# .devloops
tracker:
  provider: github              # registry key; default. External: provider + plugin (see below)
  board:                        # supersedes the deprecated queue.board
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
- `tracker.board` supersedes `queue.board` (deprecated, still accepted with a
  load-time warning — see `resolveTrackerBoard` in
  `packages/core/src/config/config.mjs`).
- **No `tracker.fieldMappings` key.** The github provider's logical-column ->
  Status mapping is the existing, already-load-bearing `queue.statusColumns`
  (read by `loadStateColumnMap` in
  `packages/core/src/loop/queue-board-sync.mjs`, keyed by the real
  `LOGICAL_COLUMN` values: `next_up`, `in_progress`, `ready_for_review`,
  `done`; unset keys fall back to `DEFAULT_STATE_COLUMN_NAMES`). Adding a
  second, tracker-owned mapping key would collide with that live one, not
  replace it — so the tracker seam documents `queue.statusColumns` as
  *the* github provider's mapping rather than inventing a parallel one. A
  future external provider defines its own logical -> status mapping (its
  shape is provider-specific) when one is actually implemented.
- `strategy: "tracker-first"` renames the former `"github-first"`.
  `"github-first"` is still accepted: `loadDevLoopConfig` normalizes it to
  `"tracker-first"` (with a load-time warning) BEFORE that layer's own
  schema validation runs — the schema enum itself only lists
  `"tracker-first"` (see the generated `schemas/dev-loop-config.schema.json`,
  which lists only the canonical value, by design). See
  `ARTIFACT-STRATEGY-ENUM-FAIL-CLOSED` in
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
holds no global/singleton state — a future multi-tracker or per-capability
resolution layer (see Non-goals) is a drop-in on top of this same call
shape; it does not need to change.

## Non-goals (v1)

- **Implementing an external tracker** (Jira/Shortcut/Linear/…) — the section
  above shows how a consumer would register one post-1.0; none ships here.
- **Multi-tracker-per-repo.** `.devloops` is loaded as a fixed layer stack at
  the repo root (not a per-directory walk-up), so there is one effective
  config — and hence one tracker — per repo today. The seam must not
  preclude this later (per-scope config resolution, or a `trackers:` routing
  map), which is why `resolveTrackerAdapter` stays config-driven with no
  global singleton.
- **Capability-split / hybrid trackers** (e.g. GitHub for code/PRs, an
  external tracker for issues+board). The interface is deliberately
  capability-grouped (Issues vs Board) so a composite adapter delegating per
  capability is possible later; `provider` may expand to
  `issues.provider`/`board.provider` sugar without a breaking rename. Not
  implemented in v1 — exactly one provider resolves one adapter per repo.
- **A generic/tracker-owned field-mapping key, or provider auto-discovery** —
  the github provider's mapping is `queue.statusColumns` (see Config above);
  a real second provider defines its own shape when it exists, rather than
  generalizing one now for a provider that doesn't.
- **The PR/VCS-host seam** (see Scope above) — orthogonal, tracked
  separately if ever wanted.

## Relationship to other docs

| Doc | Relationship |
|---|---|
| [Artifact Authority Contract](artifact-authority-contract.md) | Defines which artifact is canonical (tracker-first / local-planning / lightweight); this doc defines which *provider* backs "tracker issue" |
| [Tracker-First Story-to-PR Contract](tracker-first-loop-state.md) | PR-level state machine for tracker-driven PRs; provider-agnostic already (a plugin emits a raw state string the core normalizer understands) |
| [Projects Queue Contract](./projects-queue-contract.md) | The GitHub Projects board contract the built-in `github` provider's Board capability wraps |
