---
name: "ui-review"
description: "Internal routed strategy behind `dev-loop` for the UI-review route — the \"prove it in the running app\" review sibling of reviewer/fixer. Drives the PR through five CLI stages (provision, drive, diagnose, report, teardown), each routed as a `dev-loops loop ui-review-*` subcommand."
allowed-tools: Read Bash
user-invocable: false
---
<!-- GENERATED from skills/ui-review/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# UI Review

`dev-loops-run cli/index.mjs loop startup --pr <n> --ui-review` selects `ui_review` to review the
running app from an isolated PR worktree. Orchestrate the five CLI stages below
in order, threading each result JSON into the next; there is no chaining helper.

The two browser-driving stages (`ui-review-drive`, and the `visual-grill-capture`
stage the loop-grill uses) launch headless WebKit through Playwright, an
optional peer dependency. Install it once where a UI review runs:
`npm install --save-dev @playwright/test`, then
`npx playwright install webkit`. When the package or the browser binary is
missing, both stages stop with those instructions as the stop reason and carry no
failure entries. Thread `failures` onward, even on stopped results: runner-unavailable has none, while a missing recipe carries a `must-fix`. Diagnose never drops a failure; a setup gap must not become a PR defect.

`@axe-core/playwright` is a separate opt-in
(`npm install --save-dev @axe-core/playwright`) for the computed-a11y artifact.
Without it every `axe.json` is a JSON `null` and a11y findings lose their
grounding.

The route's handoff envelope carries its stop rules and acceptance
self-validation (defined in `handoff-envelope.mjs`): no product-code writes,
worktree-only, outward review stays pending/draft, and destructive migrations
must be acknowledged before they run.

## Provision + boot

Provision an isolated worktree for the PR head and boot the branch's app via
`dev-loops-run cli/index.mjs loop ui-review-provision --repo-root <p> --pr <n>`
(source-repo fallback: `dev-loops-run scripts/loop/ui-review-provision.mjs --repo-root <p> --pr <n>`; pure orchestration in
`packages/core/src/loop/ui-review-provision.mjs`). It refuses the primary
checkout, installs the dependency-lock delta, runs pending dev-DB migrations,
boots the app and polls an HTTP readiness probe. It fails closed to a stated stop
reason on: a primary-checkout target, a missing run recipe, a run-recipe `cwd`
that resolves outside the provisioned worktree, a destructive migration lacking
`--ack-destructive-migration`, or a readiness probe timeout. Every bounded cap is
logged.

A project declares the run recipe as `uiReview.run` in `.devloops`: a boot
`command`, an HTTP `readyUrl`, probe `readyTimeoutMs`/`readyIntervalMs`, an
optional worktree-relative `cwd`, and an optional `migrate` sub-recipe
(`statusCommand`/`applyCommand`, plus a `destructivePattern` guard). The guard
matches `destructivePattern` against the migration STATUS OUTPUT. The shipped
default detects only SQL-bearing status output (DROP/TRUNCATE/DELETE FROM). A
project whose status output lists migration identifiers or filenames MUST set a
`destructivePattern` matching its own status format (or emit the destructive
SQL/marker from `statusCommand`); otherwise the guard is inert.

Threat boundary: the run recipe is branch-controlled, and its `command` runs as a
shell command in the worktree. Every later stage treats a run recipe as
trusted-branch input.

## Drive

Drive the changed UI flows against the handed-off app URL via
`dev-loops-run cli/index.mjs loop ui-review-drive --repo-root <p> --app-url <url> --output-dir <p> [--changed-path <p> ...]`
(source-repo fallback: `dev-loops-run scripts/loop/ui-review-drive.mjs ...`; pure
orchestration in `packages/core/src/loop/ui-review-drive.mjs`). It authenticates
as the change's target role through the project's dev-login recipe, dismisses
declared interstitials, walks the selected flows and captures a step
screenshot + sibling `state.json` + `snapshot.json` + `axe.json` + `console.json` per step via `captureNamedUiState`. It fails
closed to a stated stop reason when it cannot authenticate, and drives nothing.

The stage records error responses (status <200 or >=400; 3xx redirects are not
flagged), request failures, page errors, server-log exceptions and step failures,
including errors the UI hides behind a success state. It emits ordered step
screenshots plus a structured captured-failures list that feeds the next stage.
A captured step-scoped error fails the drive closed. Every bounded cap (max
screenshots, screens skipped, the fixed no-retry policy) is logged.

Flow selection is a bounded heuristic over an explicit allowlist, never an
unbounded crawl. Each `uiReview.flows` entry declares `pathPatterns` matched
against the PR's changed file paths. An entry with none is always driven, and an
unknown diff drives every allowlisted flow. The selection is capped and the
overflow logged.

A project declares the drive recipe as `uiReview.login` (a `loginUrl`, optional
username/password field selectors with their dev-only values, a `submitSelector`,
and a `successSelector` proving the session), optional `interstitials` (dismiss
selectors), the `flows` allowlist, optional `caps` (clamped to the shipped
ceilings; a project may only tighten them), and an optional `serverLogPath`. The
default `serverLogExceptionPattern` is a heuristic that a project MUST override
when its log format differs. The login form is branch-controlled trusted input,
same threat boundary as the run recipe.

## Diagnose + anchor

Map each captured failure to a source line and then to a PR diff anchor via
`dev-loops-run cli/index.mjs loop ui-review-diagnose --pr <n> --drive-result <p> [--repo <slug>]`
(source-repo fallback: `dev-loops-run scripts/loop/ui-review-diagnose.mjs ...`; pure
mapping in `packages/core/src/loop/ui-review-diagnose.mjs`). It reuses PR
state from `loop info --pr`, parses the top in-repo stack frame (skipping
`node_modules`/`gems`/`vendor` frames) and resolves the source `file:line` to a
diff anchor `{ path, line, side: RIGHT }` on the head. Findings sort by severity,
anchorability, kind, then source `file:line`, independent of wall-clock or input
order.

Only ADDED lines are anchor targets. A failure is NEVER silently dropped: one
with no source location, a file outside the changed files, a line off a changed
diff line, or an ambiguous file mapping is retained as a non-anchorable finding
with a stated reason, and the poster body-attaches it. Each finding references
the drive's final captured screenshot/state artifact when one exists (null
otherwise). That reference is one shared object across all findings, so a
Stage-4 consumer null-checks it and must not present it as proof of a specific
finding.

## Report

Produce a head-pinned PENDING PR review and self-contained screenshot artifact via
`dev-loops-run cli/index.mjs loop ui-review-report --pr <n> --diagnose-result <p> --html-output <p> [--repo <slug>]`
(source-repo fallback: `dev-loops-run scripts/loop/ui-review-report.mjs ...`; pure
decisions in `packages/core/src/loop/ui-review-report.mjs`). It reuses the
shared pending-review poster (`scripts/github/stage-reviewer-draft.mjs` +
`buildDraftReviewPayload`). Each anchorable finding becomes an inline comment on
its exact `{path,line,side:RIGHT}` anchor with the reproduced exception and a fix
direction. Non-anchorable findings stay in the review body. The stage fails
closed when the diagnosed head is missing or the live head from `loop info` has
advanced since diagnose.

The review defaults to pending/draft (no `event`); this stage never
auto-submits. A confirmed user-facing server error (a must-fix error-response /
server-log-exception) maps to `REQUEST_CHANGES` only when submit is authorized;
otherwise the review stays pending with the severity recorded. Submitting via the
events endpoint is a separate authorized action outside this stage.

The stage always produces a CSP-safe, fully inlined HTML artifact. On the Claude
Code harness it emits a publishable directive (`{ hosting: "claude-artifact", htmlPath,
publishable: true }`); the orchestrating agent publishes it via Claude
Artifacts, and the module never calls an Artifacts tool itself. On any other
harness it returns `{ hosting: "github-gist", publishable: true, htmlPath }`, and
the CLI publishes the HTML as a secret GitHub Gist. An explicit `--hosted-url`
or `--dry-run` skips the gist publish. When the gist publish yields no URL, the
stage fails closed with a stated reason (`{ hosting: "unavailable", reason }`).
The review body links a hosted artifact when one exists and
otherwise states the artifact is unhosted with the reason, so the review never
blocks on hosting. Every bounded cap is logged.

## Teardown + side-effect ledger

Teardown consumes prior-stage results and ALWAYS emits a side-effect ledger. Invoke
`dev-loops-run cli/index.mjs loop ui-review-teardown --repo-root <p> --provision-result <p> [--drive-result <p>] [--report-result <p>] [--row-manifest <p>] [--confirm] [--no-stop-app]`
(source-repo fallback: `dev-loops-run scripts/loop/ui-review-teardown.mjs ...`; pure
decisions in `packages/core/src/loop/ui-review-teardown.mjs`).

The destructive steps (dev-DB row drops, worktree removal, and pruning the
Stage-4 hosting gist named in `--report-result`) run ONLY with an
explicit `--confirm`. Without it, those steps are skipped and the ledger records
what remains. Stopping the app still runs because the loop itself started that
process. A null PID is never a blind kill, and win32 app-stop fails closed; in
both cases the ledger reports the process may still be running. Worktree removal
delegates to `scripts/loop/cleanup-worktree.mjs`, which refuses any path outside
the loop namespace.

The ledger enumerates migrations applied (applied-not-reverted), rows
created/dropped or left behind, the worktree path and whether it was removed, and
the process status. A failed kill/drop/removal is reported in the ledger and the
result's `errors` list.

The drive tags the rows it creates with its drive-session id and emits a row
manifest. This stage MUST NOT guess which rows to drop. It drops rows only from
an explicit manifest, with `--confirm`, through
`uiReview.run.rowTeardown.deleteCommand`. When the drive walked mutating flows
and no manifest is supplied, nothing is dropped and the ledger reports rows "may
remain (untagged)". Row-drop fails CLOSED and the ledger records a drop failure
when a manifest row is untagged or the rows carry more than one session, when
`deleteCommand` is missing, or when the command exits nonzero.

## Non-goals

The teardown stage never rolls back the branch's dev-DB migrations by default and
never tears down a production DB. The stage does not auto-submit a review
without explicit authorization, publish to a production/non-dev posting target,
auto-fix the located defects,
pixel-diff for visual regression, run a cross-browser matrix, or touch a
production DB. It does not replace the product/eng `review` angle or the Copilot
gate.
