# Local Playwright/WebKit smoke harness for UI slices

This reusable WebKit config, fixture-server and capture seam underpins the shared UI-e2e harness. `test/playwright/harness/deck-fit-harness.mjs` and `test/playwright/harness/inspect-run-viewer-harness.mjs` import its config, fixture-server and named-state capture helpers. [UI e2e scoping step](./ui-e2e-scoping-step.md) owns when UI e2e coverage is required.

## Purpose

The harness is intentionally small:
- Playwright
- WebKit only
- fixture-backed scenarios
- named screenshot/state/snapshot/axe/console artifact capture
- deterministic local artifact/report locations

It is not a general E2E framework and it does not make browser validation mandatory for non-UI slices.

## Reusable baseline

The reusable baseline lives in:
- `test/playwright/harness/webkit-smoke-harness.mjs` (this module): owns the fixture-server seams and re-exports the capture surface
- `scripts/loop/ui-review-capture.mjs`: owns `captureNamedUiState` and `launchWebkit`. It sits in the shipped tree because the ui-review stages import it at runtime, and a shipped entrypoint must not import from `test/`
- the single `playwright.config.mjs`: owns the WebKit-only project shape. It derives one project per slice (deck, article, viewer) from the registries, each with its own `testMatch` and distinct `outputDir`. Run one via `--project=<sliceId>`
- the shared suites that consume it: `test/playwright/harness/deck-fit-harness.mjs` (`defineDeckSuite`/`defineArticleSuite`) and `test/playwright/harness/inspect-run-viewer-harness.mjs`

The harness exposes two main runtime seams:
- `startFixtureServer(...)` / `stopFixtureServer(...)`: start and stop a bounded local fixture-backed HTTP server for the UI surface under test
- `captureNamedUiState(...)`: write deterministic named-state artifacts for reviewer consumption (implemented in `scripts/loop/ui-review-capture.mjs`, re-exported here)

## Adoption path

The spec file **must** be named `<sliceId>.spec.mjs`, because each generated project pins `testMatch: ['<sliceId>.spec.mjs']`. `playwright.config.mjs` derives the project from the registry, so no config file is created or edited.

For a **rendered artifact** (deck, article or viewer), add a registry entry plus a thin spec calling `defineDeckSuite` / `defineArticleSuite` (see [UI e2e scoping step](./ui-e2e-scoping-step.md)). For a bespoke local UI surface that uses this WebKit seam directly:

1. add a registry entry for the slice (in the deck/article/viewer registry the config reads)
2. add a fixture-backed Playwright spec named `<sliceId>.spec.mjs` under `test/playwright/`
3. start the slice-specific fixture server with `startFixtureServer(...)`
4. exercise only the small explicit UI states needed by the slice acceptance criteria
5. call `captureNamedUiState(...)` for each named state that should remain reviewable

Keep the per-slice layer thin. The slice owns only its fixture and explicit assertions.

## Deterministic local paths

Given a `sliceId` of `inspect-run-viewer`, the baseline paths are:
- Playwright output directory: `test-results/ui-smoke/inspect-run-viewer`
- HTML report directory: `playwright-report/ui-smoke/inspect-run-viewer`
- named-state artifacts: `test-results/ui-smoke/inspect-run-viewer/named-states/<state-slug>/`

Each named-state directory contains `screenshot.png`, `state.json`, `snapshot.json`, `axe.json` and `console.json`. [UI Artifact Contract](./ui-artifact-contract.md) owns the `<state-slug>` format and the artifact contract.

## Reference example

The inspect-run viewer smoke suite is the proving example. It covers a small explicit set of viewer states:
- fixture input: `test/playwright/fixtures/inspect-run-viewer-fixture.mjs`
- spec: `test/playwright/inspect-run-viewer.spec.mjs`
- config: `playwright.config.mjs` (project `inspect-run-viewer`)
- command: `bun run test:playwright:viewer` (the package script deliberately launches Playwright with Node)

## Limitations and non-goals

This harness (the WebKit seam) does not attempt to provide:
- multi-browser coverage
- generalized E2E orchestration
- large fixture catalogs
- visual-diff baseline management
- a second public workflow entrypoint beside `dev-loop`
