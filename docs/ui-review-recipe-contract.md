# UI-Review Run/Auth Recipe Contract

The `/loop-review-ui` command reviews a pull request by proving the change in
the **running app** from an isolated worktree, rather than reading the diff
alone. To do that, the loop has to know how to boot your app, how to log in as
the change's target role, and which UI flows to drive. None of that is
hard-coded — every project declares its own recipe.

This doc is the contract a **consuming repo** satisfies so `/loop-review-ui`
can run against it. All keys below exist in the shipped config schema
(`packages/core/src/config/config.mjs`) and are enforced at load time. A
docs-accuracy test (`test/docs/ui-review-recipe-doc.test.mjs`) fails CI if the
enumerated config-key reference below drifts from the schema (in either
direction).

Every value shown is a **generic example** — replace it with your project's own.
No downstream or private identifiers belong in this repo.

## Where the recipe lives

The recipe is declared in your repo-root `.devloops` file (`.devloops.yaml`,
`.yml`, and `.json` are also accepted). Two sections are involved:

- `worktree` — which gitignored files/dirs to provision into a fresh worktree.
- `uiReview` — the boot recipe, the dev-login recipe, the changed-flow
  allowlist, and the caps.

`uiReview` is optional. When a section it needs is absent, the corresponding
stage **stops with that as a stated reason** rather than guessing how to run or
drive your app.

## The loop, in one pass

`resolve → provision/boot → auth+drive → diagnose → report → teardown`

1. **Provision + boot** — provisions an isolated worktree for the PR head,
   installs only the dependency-lock delta, runs pending dev-DB migrations, then
   boots the app and polls an HTTP readiness probe.
2. **Auth + drive** — launches one headless WebKit context, authenticates
   through your dev-login recipe, dismisses declared interstitials once, then
   walks the changed UI flows, capturing a screenshot + `state.json` + `snapshot.json` + `axe.json` per step.
3. **Diagnose** — maps each captured failure to a source line and then to a PR
   diff line so a finding can anchor on a real changed line.
4. **Report** — posts a head-pinned **pending** PR review and produces a
   self-contained HTML artifact.
5. **Teardown** — stops the booted app and, only with explicit confirmation,
   removes the worktree (the working destructive step). Dev-DB row-drop currently
   **fails closed** — the tagged-drop seam is not wired, so a confirmed manifest
   is recorded as a drop failure and untagged rows may remain (a real tagged drop
   is a tracked follow-up). A side-effect ledger is ALWAYS emitted, enumerating
   what was done vs. left behind.

## Guardrails (non-negotiable)

- **Sources-only edits.** The loop never edits generated `.claude/**` directly;
  if command help changes, sources are edited and `.claude/**` is regenerated
  via `scripts/claude/generate-claude-assets.mjs`.
- **Worktree-only.** The loop refuses to operate in the primary checkout and
  refuses a run-recipe `cwd` that resolves outside the provisioned worktree.
- **Dev-DB-only + destructive-migration acknowledgement.** Migrations run
  against the branch's dev DB only. A migration whose status output matches the
  destructive pattern is refused unless the run explicitly acknowledges it.
- **Outward review defaults to pending/draft.** The report stage never
  auto-submits; a confirmed user-facing server error maps to a change request
  **only when submit is separately authorized**.
- **Bounded caps are logged.** Every ceiling (max screenshots, max flows, max
  steps per flow) is enforced and any overflow is logged, never silent.
- **Branch-controlled input is trusted-branch input.** The run command and the
  login form come from the PR branch and are executed as such — not treated as
  untrusted data.

## `worktree` — provisioning gitignored files

A fresh worktree starts from a clean checkout, so anything gitignored that the
app needs at boot (installed dependencies, a local DB config) must be provided.
Entries are repo-relative literal paths or glob patterns.

- `worktree.copyOnInit` — copied per worktree (isolated writable copy).
- `worktree.linkOnInit` — absolute symlink into the main checkout (shared,
  treat as read-only).

```yaml
worktree:
  linkOnInit:
    - node_modules          # example: large, immutable install shared read-only
  copyOnInit:
    - config/database.local.yml   # example: gitignored local DB config
```

## `uiReview.run` — boot recipe (required to boot)

- `uiReview.run.command` — shell command that starts the app.
- `uiReview.run.readyUrl` — an `http(s)` URL an HTTP probe polls until the app
  answers (never a fixed sleep).
- `uiReview.run.readyTimeoutMs` — probe budget in ms (default `60000`).
- `uiReview.run.readyIntervalMs` — probe interval in ms (default `1000`).
- `uiReview.run.cwd` — optional worktree-relative subdir to run `command` in.
- `uiReview.run.migrate` — optional dev-DB migration sub-recipe:
  - `uiReview.run.migrate.statusCommand` — lists pending migrations (one per line).
  - `uiReview.run.migrate.applyCommand` — applies them.
  - `uiReview.run.migrate.destructivePattern` — optional regex, matched
    case-insensitively per line **against the status output**, not the
    migration files. The shipped default detects SQL-bearing status output
    (`DROP`/`TRUNCATE`/`DELETE FROM`). If your status command emits migration
    identifiers or filenames instead, the default matches nothing and the
    destructive guard is inert — set a `destructivePattern` matching your own
    status format (e.g. a `destructive`/`down` marker), or make `statusCommand`
    emit the destructive SQL/marker.

```yaml
uiReview:
  run:
    command: "bin/example-app-server --port 4000"   # example
    readyUrl: "http://127.0.0.1:4000/healthz"        # example
    readyTimeoutMs: 90000
    readyIntervalMs: 1000
    cwd: "web"                                        # example subdir
    migrate:
      statusCommand: "bin/example-migrate status"    # example
      applyCommand: "bin/example-migrate up"         # example
```

## `uiReview.login` — dev-login recipe

The drive stage obtains a session by driving this login form in the browser.
The credential is a **shared dev-only value** (a dev password or role), never a
real user secret.

- `uiReview.login.loginUrl` — an `http(s)` URL of the login page.
- `uiReview.login.usernameSelector` / `uiReview.login.usernameValue` — optional
  username field selector and its value.
- `uiReview.login.passwordSelector` / `uiReview.login.passwordValue` — optional
  password field selector and its dev-only value.
- `uiReview.login.submitSelector` — **required**; the submit control.
- `uiReview.login.successSelector` — **required**; the element that proves the
  session was established. Without it the drive stage cannot confirm auth and
  fails closed.

```yaml
uiReview:
  login:
    loginUrl: "http://127.0.0.1:4000/login"   # example
    usernameSelector: "#email"                  # example
    usernameValue: "dev@example.test"           # example dev-only account
    passwordSelector: "#password"               # example
    passwordValue: "dev-only-password"          # example dev-only credential
    submitSelector: "button[type=submit]"       # example
    successSelector: "[data-testid=user-menu]"  # example proof-of-session
```

## `uiReview.interstitials` — one-time dismissals

Selectors dismissed **once per browser context** (cookie consent, a welcome
modal). Best-effort — a missing interstitial is not an error.

- `uiReview.interstitials[].selector` — the element to click to dismiss.

```yaml
uiReview:
  interstitials:
    - selector: "#cookie-consent-accept"   # example
```

## `uiReview.flows` — the changed-flow allowlist

Flows are an **explicit allowlist**, never an unbounded crawl. Each flow
declares `pathPatterns` (plain substrings matched against the PR's changed file
paths); a flow with none is always driven, and an unknown diff drives every
allowlisted flow. The selection is capped and any overflow logged.

- `uiReview.flows[].name` — flow label.
- `uiReview.flows[].pathPatterns` — optional substrings scoping the flow to a diff.
- `uiReview.flows[].steps[].action` — one of `goto`, `click`, `fill`, `select`,
  `upload`, `dispatch`.
- `uiReview.flows[].steps[].name` — optional step label.
- `uiReview.flows[].steps[].selector` — required for every action except `goto`.
- `uiReview.flows[].steps[].path` — required for `goto` (the app path to visit).
- `uiReview.flows[].steps[].value` — required for `upload` (the file path);
  also the typed/selected value for `fill`/`select`.
- `uiReview.flows[].steps[].event` — optional event name for `dispatch`.

```yaml
uiReview:
  flows:
    - name: "create widget"                 # example
      pathPatterns: ["app/widgets/", "widgets_controller"]  # example
      steps:
        - { action: goto, path: "/widgets/new" }
        - { action: fill, selector: "#widget_name", value: "Example" }
        - { action: click, selector: "button[type=submit]" }
```

## `uiReview.caps` — bounded ceilings

Every field is optional and clamped at resolve time — a project may only
**tighten** a cap, never loosen the shipped ceiling. Retries are pinned at 0.

- `uiReview.caps.maxScreenshots`
- `uiReview.caps.maxFlows`
- `uiReview.caps.maxStepsPerFlow`

```yaml
uiReview:
  caps:
    maxScreenshots: 40
    maxFlows: 5
    maxStepsPerFlow: 20
```

## `uiReview.serverLogPath` / `uiReview.serverLogExceptionPattern`

Optional. The drive stage tails your server log so a swallowed 500 the UI hid
behind a success state is still recorded.

- `uiReview.serverLogPath` — filesystem path (worktree-relative or absolute).
- `uiReview.serverLogExceptionPattern` — optional regex; the default is a
  heuristic you **must override** when your log format differs.

```yaml
uiReview:
  serverLogPath: "log/development.log"           # example
  serverLogExceptionPattern: "(FATAL|ERROR|Exception)"  # example — match your format
```

## Artifact hosting (Stage 4)

The report stage always produces a self-contained, CSP-safe HTML artifact
(ranked findings plus the reproduced-evidence screenshot inlined as a data URI,
no external resources).

- On the **Claude Code** harness the stage emits a publishable directive and the
  artifact is published via **Claude Code Artifacts** — a zero-setup hosted link
  the review body links to. The module never calls an Artifacts tool itself; the
  orchestrating agent publishes.
- On **any other harness** hosting **fails closed with a stated reason**: the
  review body states the artifact is unhosted and why, and never blocks on
  hosting. A GitHub-native fallback publisher is a **tracked follow-up**.

## Config key reference

Every `uiReview.*` and `worktree.*` key this doc references. This list is
verified against the shipped zod schema by
`test/docs/ui-review-recipe-doc.test.mjs`; it fails if any key here is absent
from the schema or if the schema gains a key not listed here.

<!-- ui-review-config-keys:start -->
- `worktree.copyOnInit`
- `worktree.linkOnInit`
- `uiReview.run.command`
- `uiReview.run.readyUrl`
- `uiReview.run.readyTimeoutMs`
- `uiReview.run.readyIntervalMs`
- `uiReview.run.cwd`
- `uiReview.run.migrate.statusCommand`
- `uiReview.run.migrate.applyCommand`
- `uiReview.run.migrate.destructivePattern`
- `uiReview.login.loginUrl`
- `uiReview.login.usernameSelector`
- `uiReview.login.usernameValue`
- `uiReview.login.passwordSelector`
- `uiReview.login.passwordValue`
- `uiReview.login.submitSelector`
- `uiReview.login.successSelector`
- `uiReview.interstitials[].selector`
- `uiReview.flows[].name`
- `uiReview.flows[].pathPatterns`
- `uiReview.flows[].steps[].name`
- `uiReview.flows[].steps[].action`
- `uiReview.flows[].steps[].selector`
- `uiReview.flows[].steps[].path`
- `uiReview.flows[].steps[].value`
- `uiReview.flows[].steps[].event`
- `uiReview.caps.maxScreenshots`
- `uiReview.caps.maxFlows`
- `uiReview.caps.maxStepsPerFlow`
- `uiReview.serverLogPath`
- `uiReview.serverLogExceptionPattern`
<!-- ui-review-config-keys:end -->

## See also

- [UI Validation Contract](./ui-validation-contract.md)
- [UI Artifact Contract](./ui-artifact-contract.md)
- [Worktree Usage Guidance](./worktree-guidance.md)
