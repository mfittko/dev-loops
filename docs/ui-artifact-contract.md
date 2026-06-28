# UI screenshot/state artifact contract and CI promotion rules

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

For this level, a paired state artifact is required:
- `screenshot.png`
- `state.json`

Why both are required:
- the screenshot shows what rendered
- `state.json` explains which named state it is, which slice produced it, and the minimum metadata needed for review or follow-up automation

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
- HTML report root: `playwright-report/ui-smoke/<sliceId>/`

The harness currently normalizes:
- `sliceId` into a stable path segment
- the human-readable state name into `<state-slug>`

## Minimum `state.json` contract

The current reusable harness emits `state.json` with this minimum reviewer-facing metadata:
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
- `metadata.fixture`
- `metadata.route`
- `metadata.reviewHint`

This is intentionally minimal. The contract is not trying to describe every possible UI surface; it is only making the current reusable review inputs explicit.

## When screenshot alone is acceptable

Screenshot alone is acceptable only when the artifact is:
- a manual review artifact
- a one-off discussion aid
- not being presented as deterministic smoke-validation evidence
- not a registered rendered artifact whose suite is auto-scoped into CI (see [CI enforcement is auto-scoped, not promoted](#ci-enforcement-is-auto-scoped-not-promoted))

## When the paired state artifact is required

The `screenshot.png` + `state.json` pair is required when:
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
- mismatched state naming/path conventions are a validation failure
- the PR should fail closed rather than silently downgrade to screenshot-only review

## Relationship to the local harness and later reviewer loop

- [UI Smoke Harness](ui-smoke-harness.md) defines how the local harness captures these artifacts
- this document defines the reusable artifact contract and when CI should start requiring it
- later review-loop work should consume this artifact bundle rather than redefine the artifact shape from scratch
- the current designer + vision review-loop consumer contract lives in [UI Designer Review Loop](./ui-designer-review-loop.md)
