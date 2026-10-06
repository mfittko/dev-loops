# UI screenshot/state artifact contract and auto-scoped CI enforcement

Canonical owner for the named-state screenshot and evidence bundle.

## Public entrypoint and scope boundary

- `dev-loop` remains the single public entrypoint for UI validation work. This contract defines the internal **named-state artifact shape** that the shared harness emits. It adds no second public workflow name.
- The shared deck, article and viewer suites emit these artifacts through the WebKit seam in [UI Smoke Harness](./ui-smoke-harness.md). [UI e2e scoping step](./ui-e2e-scoping-step.md) owns when a PR must run those suites. That trigger is path-based and fail-closed.

## What a named UI state means here

A **named UI state** is one small explicit render or interaction state that:
- is directly tied to a slice acceptance criterion, review question, or risk boundary
- can be reproduced deterministically from a fixture-backed local smoke run
- has a stable human-readable state name and a deterministic path slug
- is narrow enough that reviewers can understand what they are looking at without replaying the whole feature manually

Examples from the inspect-run viewer: `Current PR dashboard`, `Unknown current state`, `Terminal current state`.

## Artifact levels

### 1. Manual review artifacts

Screenshots or demo captures for human discussion only. A screenshot alone is acceptable here. These artifacts may live outside the reusable harness path. They are not deterministic smoke-validation evidence and imply no CI enforcement.

### 2. Deterministic smoke-validation artifacts

The reusable harness emits these artifacts for named UI states. All five files are required for the same named state:

| Artifact | Review evidence |
|---|---|
| `screenshot.png` | Rendered pixels |
| `state.json` | Named state, producing slice and review metadata |
| `snapshot.json` | Semantic accessibility tree: roles and names |
| `axe.json` | Computed accessibility facts, including contrast |
| `console.json` | Attributed console errors and failed network requests |

These five artifacts ground the four review lenses: `a11y` (`axe.json`), `layout-geometry` (`snapshot.json`), `visual` (`screenshot.png`) and `interaction` (`console.json`). The pure `convergeUiReviewLenses` seam merges their findings. See [Designer + vision review loop](./ui-designer-review-loop.md#four-lenses-over-one-bundle-converged-deterministically).

### 3. CI-required artifacts

These artifacts use the smoke-validation shape. They belong to a registered rendered artifact (deck, article or viewer) whose suite is **auto-scoped into CI** whenever a PR touches its source. See [UI e2e scoping step](./ui-e2e-scoping-step.md).

If a required suite's expected artifacts are missing or malformed, validation fails closed.

## Deterministic path contract

For slice id `<sliceId>` and state slug `<state-slug>`:

- state directory: `test-results/ui-smoke/<sliceId>/named-states/<state-slug>/`
- artifacts: `screenshot.png`, `state.json`, `snapshot.json`, `axe.json` and `console.json`, each directly inside the state directory
- HTML report root: `playwright-report/ui-smoke/<sliceId>/`

The harness normalizes `sliceId` into a stable path segment. `<state-slug>` is `<state-name>-<viewport>-<interaction>`. Each part is normalized independently and joined with `-`:
- `<viewport>` is `w<width>h<height>` for a `{ width, height }` viewport (for example `w1280h800`), a normalized named breakpoint string, or `default` when no viewport is given.
- `<interaction>` is one of `focus`, `hover`, `error`, or `none` (the default render state when no interaction is given).

For example, `Current PR dashboard` at the default viewport with no interaction is `current-pr-dashboard-default-none`. The same state at a mobile viewport in its error render is `current-pr-dashboard-w375h667-error`. States that differ only by viewport or only by interaction-state therefore get distinct directories. A malformed viewport (non-positive or non-integer dimensions) or an unknown interaction-state is rejected fail-closed.

Two layers keep distinct named states that still collide to the same slug from overwriting each other:
- **Capture-time prevention (primary).** `captureNamedUiState` records the artifact paths it has claimed in the current run. It throws on a colliding slug **before it writes any artifacts**, so the second state fails closed. The registry is per process, so a legitimate re-run does not collide with its own prior output.
- **Bundle-validation seam (defense-in-depth).** `validateUiDesignerReviewInput` rejects any reviewed bundle that contains two named states sharing one `statePath` (`blocked_duplicate_state_slug`).

## Minimum `state.json` contract

The current reusable harness emits `state.json` with this minimum reviewer-facing metadata (current `schemaVersion`: `5`):
- `schemaVersion`
- `artifactType`
- `validationLevel`
- `sliceId`
- `stateName`
- `stateSlug`
- `viewport`
- `interactionState`
- `runId`
- `capturedAt`
- `projectName`
- `testTitle`
- `testFile`
- `artifacts.screenshot.fileName`
- `artifacts.screenshot.relativePath`
- `artifacts.state.fileName`
- `artifacts.state.relativePath`
- `artifacts.snapshot.fileName`
- `artifacts.snapshot.relativePath`
- `artifacts.axe.fileName`
- `artifacts.axe.relativePath`
- `artifacts.console.fileName`
- `artifacts.console.relativePath`
- `metadata.fixture`
- `metadata.route`
- `metadata.reviewHint`

## Best-effort evidence files

`snapshot.json`, `axe.json` and `console.json` are best-effort in content. The harness always emits each of them for every named state at the deterministic path and never skips one. `state.json` references them under `artifacts.snapshot`, `artifacts.axe` and `artifacts.console`.

### `snapshot.json` contract

`snapshot.json` is the semantic counterpart to `screenshot.png`. Its body is the raw accessibility-tree JSON for the named state. The body is JSON `null` when the page exposes no accessibility tree or the accessibility API is unavailable.

### `axe.json` contract

`axe.json` holds the raw [axe-core](https://github.com/dequelabs/axe-core) results that `@axe-core/playwright` produces against the live page: an object with `violations`/`passes`/`incomplete`/`inapplicable`. The body is JSON `null` when axe could not run: the page context is unavailable, the runner is absent in the browser build, or the optional `@axe-core/playwright` peer dependency is not installed.

Computable accessibility facts (color contrast, missing accessible names or roles, and similar) are asserted from `axe.json`, never judged from pixels. A reviewer maps each axe violation's `impact` to a finding severity with this fixed mapping:

- `critical` → `high`
- `serious` → `high`
- `moderate` → `medium`
- `minor` → `low`
- unranked / unknown impact → `medium` (conservative default)

### `console.json` contract

`console.json` holds the console errors and failed network requests attributed to the named state. Its body is a `{ consoleErrors, failedRequests }` report, or JSON `null` when nothing was captured for the state. `consoleErrors` are uncaught page errors, each with `message` and a bounded `stack`. `failedRequests` are error responses (status `<200`/`>=400`) and failed requests.

The drive fills `console.json` by slicing its single walk-level listener buffer into the state that was active when each event fired. The slice does **not** clear the buffer. The same classified events still reach the drive's walk-level failure gate. A captured console or network error is therefore a **mechanical, mode-independent fail-closed signal**: it flips the drive's `ok` to false and keeps its source-line anchoring. A captured console or network error is never silently dropped.

`console.json` and the walk-level failure set are two views of the same events. The `ui-review-report` stage posts only the diagnosed findings from the walk-level failure set and does not read `console.json`, so the report posts each error once. No stage deduplicates `console.json` entries against those findings. The [vision review template](../dev-loop/templates/ui-vision-review.md) tells the reviewer to read `console.json` as evidence and not to re-file its errors.

## When screenshot alone is acceptable

Screenshot alone is acceptable only when the artifact is:
- a manual review artifact
- a one-off discussion aid
- not being presented as deterministic smoke-validation evidence
- not a registered rendered artifact whose suite is auto-scoped into CI (see [CI enforcement is auto-scoped, not promoted](#ci-enforcement-is-auto-scoped-not-promoted))

## When the state artifact bundle is required

The `screenshot.png` + `state.json` + `snapshot.json` + `axe.json` + `console.json` bundle is required when:
- the artifact is part of the reusable deterministic smoke harness
- the slice is handing named UI states to a later reviewer loop
- the artifact needs to map back to a deterministic local run without guesswork
- the artifact belongs to a registered rendered artifact whose suite is auto-scoped into CI

## CI enforcement is auto-scoped, not promoted

CI enforcement is not a per-slice promotion decision. A registered rendered artifact (deck, article, or the viewer) must carry passing UI e2e coverage whenever a PR touches its source. The trigger is the changed-file set matched against explicit globs, and the gate fails closed otherwise. [UI e2e scoping step](./ui-e2e-scoping-step.md) owns the criterion, the registries and the satisfiable CI jobs (`deck-smoke`, `article-smoke`, `viewer-smoke`, matching `UI_E2E_CHECK_NAMES`). These three path- and diff-conditioned jobs live in `.github/workflows/ci.yml`.

## Failure policy for required suites

When a registered artifact's suite is required, each of these is a validation failure:
- missing or malformed `state.json`, `snapshot.json`, `axe.json` or `console.json`
- missing `screenshot.png`
- mismatched state naming or path conventions

The PR should fail closed rather than silently downgrade to screenshot-only review.

## Relationship to the local harness and later reviewer loop

[UI Smoke Harness](ui-smoke-harness.md) defines how the local harness captures these artifacts. This document defines the artifact contract and when CI requires it. Review loops consume this bundle and do not redefine its shape. The designer + vision consumer contract lives in [UI Designer Review Loop](./ui-designer-review-loop.md).
