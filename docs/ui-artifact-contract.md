# UI screenshot/state artifact contract and auto-scoped CI enforcement

This document defines the bounded screenshot/state artifact contract introduced for issue #125 under umbrella issue #97.

## Public entrypoint and scope boundary

- `dev-loop` remains the single public entrypoint for UI validation work.
- This contract documents the internal **named-state artifact shape** the shared
  harness emits; it does not introduce a second public workflow name.
- The shared deck/article/viewer suites emit these artifacts via the WebKit seam
  from [UI Smoke Harness](./ui-smoke-harness.md). *When* a PR is required to run
  those suites is path-triggered and fail-closed, not opt-in — see
  [UI e2e scoping step](../skills/docs/ui-e2e-scoping-step.md).

## What a named UI state means here

A **named UI state** is one small explicit render or interaction state that:
- is directly tied to a slice acceptance criterion, review question, or risk boundary
- can be reproduced deterministically from a fixture-backed local smoke run
- has a stable human-readable state name and a deterministic path slug
- is narrow enough that reviewers can understand what they are looking at without replaying the whole feature manually

Examples from the current inspect-run viewer proving path:
- `Current PR dashboard`
- `Checkpoint only graph uncertainty`
- `Terminal merged state`

## Artifact levels

This contract distinguishes three bounded artifact levels.

### 1. Manual review artifacts

These are screenshots or demo captures created for human discussion only.

- screenshot alone is acceptable here
- they may live outside the reusable harness path
- they are not deterministic smoke-validation evidence
- they do not imply CI enforcement

### 2. Deterministic smoke-validation artifacts

These are the reusable harness artifacts emitted for named UI states.

For this level, a state artifact bundle is required:
- `screenshot.png`
- `state.json`
- `snapshot.json`
- `axe.json`
- `console.json`

Why all five are required:
- the screenshot shows what rendered
- `state.json` explains which named state it is, which slice produced it, and the minimum metadata needed for review or follow-up automation
- `snapshot.json` is the semantic accessibility tree captured for the same state — the structured counterpart to the pixels, so a reviewer (or later automation) can reason about roles/names, not just what a screenshot happens to show
- `axe.json` is the computed accessibility facts (axe-core results) for the same state, so contrast and other computable a11y issues are asserted from a tool, not eyeballed from pixels
- `console.json` is the console errors and failed network requests attributed to the same state, so a swallowed error (a 500 hidden behind a success toast, an uncaught page error) is a review input rather than something only a live re-run would surface

### 3. CI-required artifacts

These use the same deterministic artifact shape as smoke-validation artifacts, but
the artifact belongs to a registered rendered artifact (deck, article, or the
viewer) whose suite is **auto-scoped into CI** whenever a PR touches its source —
see [UI e2e scoping step](../skills/docs/ui-e2e-scoping-step.md).

If a required suite's expected artifacts are missing or malformed, validation fails
closed.

## Deterministic path contract

For a slice id of `<sliceId>` and a state slug of `<state-slug>`, the harness path is:

- state directory: `test-results/ui-smoke/<sliceId>/named-states/<state-slug>/`
- screenshot artifact: `test-results/ui-smoke/<sliceId>/named-states/<state-slug>/screenshot.png`
- structured state artifact: `test-results/ui-smoke/<sliceId>/named-states/<state-slug>/state.json`
- semantic snapshot artifact: `test-results/ui-smoke/<sliceId>/named-states/<state-slug>/snapshot.json`
- computed a11y artifact: `test-results/ui-smoke/<sliceId>/named-states/<state-slug>/axe.json`
- console/network artifact: `test-results/ui-smoke/<sliceId>/named-states/<state-slug>/console.json`
- HTML report root: `playwright-report/ui-smoke/<sliceId>/`

The harness currently normalizes:
- `sliceId` into a stable path segment
- the human-readable state name into `<state-slug>`

## Minimum `state.json` contract

The current reusable harness emits `state.json` with this minimum reviewer-facing metadata (current `schemaVersion`: `4`):
- `schemaVersion`
- `artifactType`
- `validationLevel`
- `sliceId`
- `stateName`
- `stateSlug`
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

This is intentionally minimal. The contract is not trying to describe every possible UI surface; it is only making the current reusable review inputs explicit.

## `snapshot.json` contract

`snapshot.json` is the semantic counterpart to `screenshot.png`: the page's
accessibility tree as captured by the harness for the same named state. Its
body is the raw accessibility-tree JSON (an object tree, or JSON `null` when no
accessibility tree is available — the page exposes none, or the accessibility API
is unavailable — still emitted, never skipped). It is
emitted for every named state at the deterministic path above, and `state.json`
references it under `artifacts.snapshot`.

## `axe.json` contract

`axe.json` is the computed accessibility facts for the same named state: the raw
[axe-core](https://github.com/dequelabs/axe-core) results as produced by
`@axe-core/playwright` running against the live page. Its body is the raw axe
results JSON (an object with `violations`/`passes`/`incomplete`/`inapplicable`),
or JSON `null` when axe could not run — the page context is unavailable, or the
runner is absent in the current browser build. Like `snapshot.json`, it is
best-effort in content but always emitted for every named state (never skipped)
at the deterministic path above, and `state.json` references it under
`artifacts.axe`.

`axe.json` exists so computable accessibility facts (color contrast, missing
accessible names/roles, and similar) are asserted from a tool rather than judged
from pixels by a reviewer. A reviewer maps each axe violation's `impact` to a
finding severity with this fixed mapping:

- `critical` → `high`
- `serious` → `high`
- `moderate` → `medium`
- `minor` → `low`
- unranked / unknown impact → `medium` (conservative default)

## `console.json` contract

`console.json` is the console errors and failed network requests attributed to
the same named state. Its body is a `{ consoleErrors, failedRequests }` report —
`consoleErrors` are uncaught page errors (each with `message` and a bounded
`stack`), `failedRequests` are error responses (status `<200`/`>=400`) and failed
requests — or JSON `null` when nothing was captured for the state. Like
`snapshot.json` and `axe.json`, it is best-effort in content but always emitted
for every named state (never skipped) at the deterministic path above, and
`state.json` references it under `artifacts.console`.

`console.json` is populated by **slicing the live drive's single walk-level
listener buffer** into the state active when the events fired — it is per-state
attribution of the console/network errors the drive already captures, not a new
capture mechanism. The slice does **not** clear the buffer: the same classified
events still reach the drive's walk-level failure gate, so a captured
console/network error is a **mechanical, mode-independent fail-closed signal**
(it flips the drive's `ok` to false and keeps its source-line anchoring), not
merely a review hint. Attribution (`console.json`) and the mechanical failure gate
are two views of the same classified events; the final report dedups so the same
error is not posted twice. A captured console/network error is never silently
dropped.

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

CI enforcement is no longer a per-slice promotion decision. A registered rendered
artifact (deck, article, or the viewer) is required to carry passing UI e2e
coverage whenever a PR touches its source — the trigger is the changed-file set
matched against explicit globs, and the gate fails closed otherwise. The criterion,
the registries, and the satisfiable CI jobs (`deck-smoke`, `article-smoke`,
`viewer-smoke`, matching `UI_E2E_CHECK_NAMES`) are owned by
[UI e2e scoping step](../skills/docs/ui-e2e-scoping-step.md). These three
path/diff-conditioned jobs live in `.github/workflows/ci.yml`.

## Failure policy for required suites

When a registered artifact's suite is required:
- missing or malformed `state.json` is a validation failure
- missing `screenshot.png` is a validation failure
- missing or malformed `snapshot.json` is a validation failure
- missing or malformed `axe.json` is a validation failure
- missing or malformed `console.json` is a validation failure
- mismatched state naming/path conventions are a validation failure
- the PR should fail closed rather than silently downgrade to screenshot-only review

## Relationship to the local harness and later reviewer loop

- [UI Smoke Harness](ui-smoke-harness.md) defines how the local harness captures these artifacts
- this document defines the reusable artifact contract and when CI should start requiring it
- later review-loop work should consume this artifact bundle rather than redefine the artifact shape from scratch
- the current designer + vision review-loop consumer contract lives in [UI Designer Review Loop](./ui-designer-review-loop.md)
