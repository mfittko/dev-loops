---
name: "ui-review"
description: "Internal routed strategy behind `dev-loop` for the UI-review route — the \"prove it in the running app\" review sibling of reviewer/fixer. Drives the PR through five CLI stages (provision, drive, diagnose, report, teardown), each routed as a `dev-loops loop ui-review-*` subcommand."
allowed-tools: Read Bash
user-invocable: false
---
<!-- GENERATED from skills/ui-review/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# UI Review

`dev-loops loop startup --pr <n> --ui-review` routes the PR to this strategy
deterministically. When the public router selects `ui_review`, this route
reviews a PR by proving the change in the running app from an isolated
worktree, rather than reading the diff alone. It is the running-app review
sibling of the `reviewer_fixer` route.

Each stage below is invoked as a `dev-loops` CLI subcommand
(`dev-loops loop ui-review-provision`, `ui-review-drive`, `ui-review-diagnose`,
`ui-review-report`, `ui-review-teardown`) — the agent orchestrates the
sequence, threading each stage's result JSON into the next per its contract;
there is no separate chaining orchestrator.

The route's handoff envelope carries its stop rules and acceptance
self-validation (defined in `handoff-envelope.mjs`): no product-code writes,
worktree-only, outward review stays pending/draft, and destructive migrations
must be acknowledged before they run.

## Provision + boot

The route's first operational step provisions an isolated worktree for the PR
head and boots the branch's app to a ready state, via
`dev-loops loop ui-review-provision --repo-root <p> --pr <n>`
(source-repo fallback: `node scripts/loop/ui-review-provision.mjs --repo-root <p> --pr <n>`; pure orchestration in
`packages/core/src/loop/ui-review-provision.mjs`). It
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
`dev-loops loop ui-review-drive --repo-root <p> --app-url <url> --output-dir <p> [--changed-path <p> ...]`
(source-repo fallback: `node scripts/loop/ui-review-drive.mjs ...`; pure
orchestration in `packages/core/src/loop/ui-review-drive.mjs`). It launches
one headless WebKit context, authenticates as the change's target role through a
project-provided dev-login recipe, dismisses config-declared interstitials once
per context, then walks the selected flows — rendering each page and exercising
its declared create/edit/reorder/upload/toggle interactions — capturing a step
screenshot + sibling `state.json` + `snapshot.json` + `axe.json` + `console.json` per step via `captureNamedUiState`. It fails
closed to a stated stop reason when it cannot authenticate, and drives nothing.

Throughout the walk, `response`, `requestfailed`, and `pageerror` listeners run
and the project server log is tailed, so a swallowed error response (a 500 the UI
hides behind a success state) is still recorded. An error response is a status
<200 or >=400; 3xx redirects are normal navigation (login/canonical) and are not
flagged. Each per-step capture SLICES that listener buffer into the step's
`console.json` (per-state attribution of console errors + failed requests)
WITHOUT clearing it, so the same classified events still reach the walk-level
failure gate — a captured step-scoped error deterministically fails the drive
closed and keeps its source-line anchoring. The stage emits an ordered set of
step screenshots plus a structured captured-failures list (error responses,
request failures, page errors, server-log exceptions, and step failures) that
feeds the next stage; the final report dedups per-state attribution against that
list so the same error is not posted twice. Every bounded cap — max
screenshots, screens skipped, and the fixed no-retry policy — is logged
explicitly.

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

## Diagnose + anchor

Once failures are captured, the route maps each one to a source line and then to
a PR diff line so the poster can anchor an inline comment on a real changed line,
via
`dev-loops loop ui-review-diagnose --pr <n> --drive-result <p> [--repo <slug>]`
(source-repo fallback: `node scripts/loop/ui-review-diagnose.mjs ...`; pure
mapping in `packages/core/src/loop/ui-review-diagnose.mjs`). It reuses PR
state from `loop info --pr` rather than re-fetching, fetches the PR's unified
diff, and for each failure parses the exception type/message plus the top in-repo
stack frame (JS `at` frame, Ruby/Python traceback frame; vendor/framework frames
in `node_modules`/`gems`/`vendor` are skipped). It then resolves the source
`file:line` to a diff anchor `{ path, line, side: RIGHT }` on the head.

Only ADDED lines are anchor targets: an inline comment lands on code the PR
introduced, never on an unchanged context line. A failure is NEVER silently
dropped — one with no source location, a file that is not among the changed
files, a line that is not on a changed diff line, or a file that maps
ambiguously to more than one changed file is retained as a finding flagged
non-anchorable (with a stated reason) so the poster body-attaches it instead of
inlining. Each finding carries a reference to the drive's final captured
screenshot/state artifact when one exists (null otherwise) — a single shared
object across all findings, NOT per-failure attribution — so a Stage-4 consumer
null-checks it and must not present it as proof of a specific finding.

The findings list is ranked deterministically — severity, then anchorable-first,
then kind, then source `file:line` — with no wall-clock or input-order
dependence, so the same failures always produce the same ordered output.

## Report

The terminal reporting stage turns the ranked findings into a head-pinned
PENDING PR review plus a self-contained screenshot artifact, via
`dev-loops loop ui-review-report --pr <n> --diagnose-result <p> --html-output <p> [--repo <slug>]`
(source-repo fallback: `node scripts/loop/ui-review-report.mjs ...`; pure
decisions in `packages/core/src/loop/ui-review-report.mjs`). It reuses the
shared pending-review poster (`scripts/github/stage-reviewer-draft.mjs` +
`buildDraftReviewPayload`) — a caller/adapter, not a new poster. Each anchorable
finding becomes an inline comment on its exact `{path,line,side:RIGHT}` anchor
carrying the reproduced exception + a fix direction; non-anchorable findings are
retained in the review body (never dropped). It reuses the live head SHA from
`loop info` and fails closed when the diagnosed head is missing or the live head
has advanced since diagnose, so the inline anchors always bind to the exact
reviewed commit.

The review defaults to **pending/draft** (no `event`) — this stage never
auto-submits. A confirmed user-facing server error (a must-fix error-response /
server-log-exception) maps to `REQUEST_CHANGES` **only when submit is
authorized**; otherwise the review stays pending with the severity recorded. The
severity->event decision is emitted as guidance; submitting via the events
endpoint is a separate authorized action outside this stage.

The self-contained artifact is always produced: a CSP-safe, fully inlined HTML
(ranked findings + the reproduced-evidence screenshot as a data URI, no external
resources). Hosting is harness-aware: on the **Claude Code** harness the stage
emits a publishable directive (`{ hosting: "claude-artifact", htmlPath,
publishable: true }`) for the orchestrating agent to publish via Claude
Artifacts — the module never calls an Artifacts tool itself. On any other
harness it **fails closed with a stated reason** (`{ hosting: "unavailable",
reason, followup }`); the GitHub-native fallback publisher is deferred. The
review body links a hosted artifact when one exists and otherwise states the
artifact is unhosted (with the reason), so the review never blocks on hosting.
Every bounded cap — findings truncated past the artifact cap, an oversized or
unreadable evidence screenshot omitted — is logged, never silent.

## Teardown + side-effect ledger

The terminal cleanup stage tears down the loop's transient state — stops the
app booted in provision, drops the dev-DB rows the drive created, removes the
provisioned worktree — and ALWAYS emits a side-effect ledger so nothing is
silently orphaned, via
`dev-loops loop ui-review-teardown --repo-root <p> --provision-result <p> [--drive-result <p>] [--row-manifest <p>] [--confirm] [--no-stop-app]`
(source-repo fallback: `node scripts/loop/ui-review-teardown.mjs ...`; pure
decisions in `packages/core/src/loop/ui-review-teardown.mjs`). It reads
the prior-stage result JSON — the app PID + applied migrations + worktree path
from provision, and the rows-created signal from the drive.

The destructive steps (dev-DB row drops and worktree removal) run ONLY with an
explicit `--confirm`. Without it, those steps are skipped and the ledger records
what remains; stopping the app still runs, because it is a clean shutdown of a
process the loop itself started, not a mutation of persisted state. The app is
stopped via the provision boot PID (SIGTERM, then a LOGGED SIGKILL fallback); a
null PID is never a blind kill — the ledger reports the process may still be
running. On win32 the app-stop fails closed (process-group kill is unsupported,
so the kill is not attempted): the ledger reports may-be-running rather than a
false stopped. Worktree removal delegates to `scripts/loop/cleanup-worktree.mjs`,
which refuses any path outside the loop namespace and leaves the primary
checkout untouched.

The side-effect ledger is emitted in EVERY case (success, skip, partial
failure) and enumerates: migrations applied (recorded as applied-not-reverted —
reversing a dev-DB migration is a separate explicit action, never a default),
rows created/dropped or left behind, the worktree path + whether it was removed,
and the process status. A failed kill/drop/removal is reported in the ledger and
the result's `errors` list, never swallowed.

Row dropping is honest about a known limitation: the drive does not tag the
dev-DB rows it creates with a session id or manifest, so this stage cannot know
which rows to drop and MUST NOT guess. It drops rows only from an explicit
manifest handed in; when the drive walked mutating flows without one, the ledger
reports rows "may remain (untagged)". Making the drop real requires row/session
tagging upstream in the drive. The CLI's row-drop seam is not yet wired: a
confirmed manifest fails CLOSED (the ledger records a drop failure, never a drop)
rather than silently no-op'ing, so a caller can never believe rows were dropped;
wiring a real drop is a tracked follow-up.

## Non-goals

The teardown stage never rolls back the branch's dev-DB migrations by default
(the ledger records they were applied, not reverted) and never tears down a
production DB. The stage does not auto-submit a review
without explicit authorization, publish to a production/non-dev posting target,
ship the GitHub-native hosted-artifact fallback, auto-fix the located defects,
pixel-diff for visual regression, run a cross-browser matrix, or touch a
production DB — those are later stages or explicit non-goals. It does not
replace the product/eng `review` angle or the Copilot gate.
