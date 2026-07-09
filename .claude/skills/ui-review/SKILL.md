---
name: "ui-review"
description: "Internal routed strategy behind `dev-loop` for the UI-review route — the \"prove it in the running app\" review sibling of reviewer/fixer. Scaffold slice only: registers the route, its stop rules, and its acceptance self-validation."
allowed-tools: Read Bash
user-invocable: false
---
<!-- GENERATED from skills/ui-review/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


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

## Drive

Once the app is booted, the route drives the changed UI flows against the
handed-off app URL via
`scripts/loop/ui-review-drive.mjs --repo-root <p> --app-url <url> --output-dir <p> [--changed-path <p> ...]`
(pure orchestration in `packages/core/src/loop/ui-review-drive.mjs`). It launches
one headless WebKit context, authenticates as the change's target role through a
project-provided dev-login recipe, dismisses config-declared interstitials once
per context, then walks the selected flows — rendering each page and exercising
its declared create/edit/reorder/upload/toggle interactions — capturing a step
screenshot + sibling `state.json` per step via `captureNamedUiState`. It fails
closed to a stated stop reason when it cannot authenticate, and drives nothing.

Throughout the walk, `response` (non-2xx), `requestfailed`, and `pageerror`
listeners run and the project server log is tailed, so a swallowed non-2xx (a 500
the UI hides behind a success state) is still recorded. The stage emits an
ordered set of step screenshots plus a structured captured-failures list
(non-2xx responses, request failures, page errors, server-log exceptions) that
feeds the next stage. Every bounded cap — max screenshots, screens skipped, and
the fixed no-retry policy — is logged explicitly.

Which flows are driven is a bounded heuristic over an explicit allowlist, never
an unbounded crawl: each `uiReview.flows` entry declares `pathPatterns` matched
against the PR's changed file paths; an entry with none is always driven, and an
unknown diff drives every allowlisted flow. The selection is capped and the
overflow logged.

The drive recipe is per-project and never hard-coded: a project declares
`uiReview.login` (a `loginUrl`, optional username/password field selectors with
their dev-only values, a `submitSelector`, and a `successSelector` proving the
session), optional `interstitials` (dismiss selectors), the `flows` allowlist,
optional `caps` (clamped to the shipped ceilings — a project may only tighten
them), and an optional `serverLogPath` (with a `serverLogExceptionPattern`
defaulting to a heuristic that a project MUST override when its log format
differs). The login form is branch-controlled trusted input, same threat
boundary as the run recipe.

## Non-goals

No diagnose/report/teardown logic lives here yet. The drive stage does not map an
exception to its source line, post the review, pixel-diff for visual regression,
run a cross-browser matrix, or touch a production DB — those are later stages or
explicit non-goals.
