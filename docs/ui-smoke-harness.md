# Local Playwright/WebKit smoke harness for UI slices

This document defines the minimal reusable local WebKit config/server/capture seam
introduced for issue #124 under umbrella issue #97. It is the **lower layer**
the shared UI-e2e harness builds on: `test/playwright/harness/deck-fit-harness.mjs`
and `test/playwright/harness/inspect-run-viewer-harness.mjs` import this module's
config, fixture-server, and named-state capture helpers.

When UI e2e coverage is **required** is no longer an opt-in convention — it is
path-triggered and fail-closed (see
[UI e2e scoping step](../skills/docs/ui-e2e-scoping-step.md)). This document covers
the reusable WebKit/config/capture mechanics those required suites reuse.

## Purpose

The harness is intentionally small:
- Playwright
- WebKit only
- fixture-backed scenarios
- named screenshot/state artifact capture
- deterministic local artifact/report locations

It is not a general E2E framework and it does not make browser validation mandatory for non-UI slices.

## Reusable baseline

The reusable baseline lives in:
- `test/playwright/harness/webkit-smoke-harness.mjs` (this module)
- the single `playwright.config.mjs` — one Playwright project per slice (deck,
  article, viewer), generated from the registries, each with its own
  `testMatch` and distinct `outputDir`; run one via `--project=<sliceId>`
- the shared suites that consume it: `test/playwright/harness/deck-fit-harness.mjs`
  (`defineDeckSuite`/`defineArticleSuite`) and
  `test/playwright/harness/inspect-run-viewer-harness.mjs`

The single `playwright.config.mjs` owns the WebKit-only project shape and
deterministic per-slice `outputDir`; it derives one project per slice from the
registries, so no config edit (and no per-slice config factory) is needed.

The harness exposes two main runtime seams:
- `startFixtureServer(...)` / `stopFixtureServer(...)` — start and stop a bounded local fixture-backed HTTP server for the UI surface under test
- `captureNamedUiState(...)` — write deterministic named-state artifacts for reviewer consumption

## Adoption path

For a **rendered artifact** (deck, article, or the viewer) registration is the
path — add a registry entry plus a thin spec calling `defineDeckSuite` /
`defineArticleSuite`; `playwright.config.mjs` derives a project from the
registry automatically, so no config edit is needed
(see [UI e2e scoping step](../skills/docs/ui-e2e-scoping-step.md)). The spec file
**must** be named `<sliceId>.spec.mjs`: each generated project pins
`testMatch: ['<sliceId>.spec.mjs']`, so the spec basename and the registry
`sliceId` are coupled. For a bespoke local UI surface that uses this WebKit seam
directly:

1. add a registry entry for the slice (in the deck/article/viewer registry the config reads)
2. add a fixture-backed Playwright spec named `<sliceId>.spec.mjs` under `test/playwright/` — no new/thin config file is created
3. start the slice-specific fixture server with `startFixtureServer(...)`
4. exercise only the small explicit UI states needed by the slice acceptance criteria
5. call `captureNamedUiState(...)` for each named state that should remain reviewable

Keep the per-slice layer thin. The shared harness owns the repeatable WebKit/report/artifact shape; the slice should only own its fixture and explicit assertions.

## Deterministic local paths

Given a `sliceId` of `inspect-run-viewer`, the baseline paths are:
- Playwright output directory: `test-results/ui-smoke/inspect-run-viewer`
- HTML report directory: `playwright-report/ui-smoke/inspect-run-viewer`
- named-state artifacts: `test-results/ui-smoke/inspect-run-viewer/named-states/<state-slug>/`

Each named-state directory currently contains:
- `screenshot.png`
- `state.json`

These paths are the local proving ground for the reusable artifact contract in [UI Artifact Contract](./ui-artifact-contract.md) and for later designer-review-loop work.

## Reference example

The current proving example is the inspect-run viewer smoke suite:
- fixture input: `test/playwright/fixtures/inspect-run-viewer-fixture.mjs`
- spec: `test/playwright/inspect-run-viewer.spec.mjs`
- config: `playwright.config.mjs` (project `inspect-run-viewer`)
- command: `npm run test:playwright:viewer`

The example intentionally covers a small explicit set of viewer states rather than broad end-to-end workflows.

## Limitations and non-goals

This harness (the WebKit seam) does not attempt to provide:
- multi-browser coverage
- generalized E2E orchestration
- large fixture catalogs
- visual-diff baseline management
- a second public workflow entrypoint beside `dev-loop`

CI enforcement for the shared rendered-artifact suites is **required and
auto-scoped**, not promoted per slice — see
[UI e2e scoping step](../skills/docs/ui-e2e-scoping-step.md). The named-state
artifact shape these suites emit is documented in
[UI Artifact Contract](./ui-artifact-contract.md).
