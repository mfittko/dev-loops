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
missing run recipe, a destructive migration lacking `--ack-destructive-migration`,
or a readiness probe that times out. Every bounded cap is logged.

The run recipe is per-project and never hard-coded: a project declares
`uiReview.run` in `.devloops` — a boot `command`, an HTTP `readyUrl`, probe
`readyTimeoutMs`/`readyIntervalMs`, and an optional `migrate` sub-recipe
(`statusCommand`/`applyCommand`, plus a `destructivePattern` guard).

## Non-goals

No drive/diagnose/report/teardown logic lives here yet, and provision+boot does
not drive the browser, authenticate, capture screenshots, post the review, or
touch a production DB — those are later stages.
