---
name: ui-review
description: >-
  Internal routed strategy behind `dev-loop` for the UI-review route — the
  "prove it in the running app" review sibling of reviewer/fixer. Scaffold slice
  only: registers the route, its stop rules, and its acceptance self-validation.
compatibility: Pi skill for git+GitHub repositories. Requires gh auth.
allowed-tools: read bash
user-invocable: false
---

# UI Review (scaffold)

When the public router selects `ui_review`, this route reviews a PR by proving
the change in the running app from an isolated worktree, rather than reading the
diff alone. It is the running-app review sibling of the `reviewer_fixer` route.

The route's handoff envelope carries its stop rules and acceptance
self-validation (defined in `handoff-envelope.mjs`): no product-code writes,
worktree-only, outward review stays pending/draft, and destructive migrations
must be acknowledged before they run.

## Provision + boot

The route's first operational step provisions an isolated worktree for the PR
head and boots the branch's app to a ready state, via
`scripts/loop/ui-review-provision.mjs --repo-root <p> --pr <n>`
(pure orchestration in `packages/core/src/loop/ui-review-provision.mjs`). It
reuses the worktree machinery (`ensure-worktree`, `provision-worktree`), refuses
to operate in the primary checkout, installs only the dependency-lock delta,
runs pending dev-DB migrations, then boots the app and polls an HTTP readiness
probe. It fails closed to a stated stop reason on: a primary-checkout target, a
missing run recipe, a run-recipe `cwd` that resolves outside the provisioned
worktree (worktree traversal), a destructive migration lacking
`--ack-destructive-migration`, or a readiness probe that times out. Every
bounded cap is logged.

The run recipe is per-project and never hard-coded: a project declares
`uiReview.run` in `.devloops` — a boot `command`, an HTTP `readyUrl`, probe
`readyTimeoutMs`/`readyIntervalMs`, an optional worktree-relative `cwd`, and an
optional `migrate` sub-recipe (`statusCommand`/`applyCommand`, plus a
`destructivePattern` guard). The destructive guard matches `destructivePattern`
against the migration STATUS OUTPUT, not the migration files: the shipped
default only detects SQL-bearing status output (DROP/TRUNCATE/DELETE FROM). A
project whose status output lists migration identifiers/filenames instead gets
no protection from the default and MUST set a `destructivePattern` matching its
own status format (or emit the destructive SQL/marker from `statusCommand`) —
otherwise the guard is silently inert.

Threat boundary: the run recipe is branch-controlled, and its `command` is
executed as a shell command in the worktree. Every later stage inherits this
assumption — a run recipe is trusted-branch input, not untrusted data.

## Non-goals

No drive/diagnose/report/teardown logic lives here yet, and provision+boot does
not drive the browser, authenticate, capture screenshots, post the review, or
touch a production DB — those are later stages.
