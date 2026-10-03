# UI e2e scoping step

Canonical owner for **when the shared UI/mobile e2e loop is required**. Inclusion is **path-triggered and deterministic**. It does not depend on a human annotating the PR or a phase doc.

## Trigger: a rendered-artifact change requires UI e2e coverage

A PR that **adds or modifies a rendered HTML artifact** MUST run the shared UI e2e assertions (mobile + desktop) AND register that artifact in the e2e suite, except for the explicit manual-only browser scheduling policy below. A "rendered artifact" is anything that renders to a served page or component:

- a presentation deck: `docs/presentations/*.html` (registered in `DECK_REGISTRY`)
- an article page: `docs/articles/*.html` (registered in `ARTICLE_REGISTRY`; the intro article is the published landing page)
- the inspect-run viewer's served page/component: `scripts/loop/inspect-run-viewer.mjs`

The trigger is the PR's **changed-file set** matched against these explicit globs: exact directory + single-segment `*.html` globs (no recursion) and the viewer source path (issue #976 scope).

Registration is keyed on the **full repo-relative path**, not the basename. `docs/articles/X.html` and `docs/presentations/X.html` (for example `introducing-dev-loops.html`) are therefore **distinct** artifacts. Editing the article never counts as deck coverage, and the reverse also holds.

### Examples — required

- `docs/presentations/introducing-dev-loops.html` edited → UI e2e **required** (deck-smoke CI job runs the deck fit specs).
- `docs/articles/introducing-dev-loops.html` (the landing page) edited → UI e2e **required** (article-smoke CI job runs the article fit specs); it is its own registration, NOT covered by the same-named deck.
- A new `docs/articles/new-page.html` added → UI e2e **required**. The new page is not yet in `ARTICLE_REGISTRY`, so the gate **fails closed** until it is registered (add an entry + a thin spec calling `defineArticleSuite`).
- `scripts/loop/inspect-run-viewer.mjs` edited → UI e2e **required** (the viewer is registered in `VIEWER_REGISTRY`).

### Examples — not required

- `packages/core/src/loop/copilot-loop-state.mjs`, `README.md`, `*.test.mjs`, `docs/articles/foo.md` (not `.html`), or a nested `docs/articles/sub/x.html` (the glob is single-segment) → UI e2e **not required**; the gate passes through.

## Register the artifact in the suite

"Registered" means the artifact appears in the shared registries:

- decks → `DECK_REGISTRY` in `test/playwright/harness/deck-fit-harness.mjs` (served from `docs/presentations/<deck>`) with a thin spec calling `defineDeckSuite`.
- articles → `ARTICLE_REGISTRY` in `test/playwright/harness/deck-fit-harness.mjs` (served from `docs/articles/<file>`) with a thin spec calling `defineArticleSuite` (shared fit/CSP/no-horizontal-scroll assertions, minus the deck's per-section named captures).
- the viewer → `VIEWER_REGISTRY` in `test/playwright/harness/inspect-run-viewer-harness.mjs`.

The gate checks membership against `packages/core/src/loop/ui-e2e-scoping.mjs` (`REGISTERED_ARTIFACT_PATHS`, keyed by full repo-relative path; `VIEWER_ARTIFACT_ID`). Keep these paths aligned with the shared registries. Actual Playwright discovery tests protect automatic and explicit manual project selection.

## Fail-closed semantics

The check is a gate precondition in `evaluatePrGateCoordination` (`packages/core/src/loop/pr-gate-coordination.mjs`), separate from the mergeability (#980) and retrospective (#982) preconditions. It fails closed:

- **Unregistered rendered artifact touched** → gate blocks with `nextAction: run_ui_e2e_suite`, reason naming the artifact and that it needs registration in the suite.
- **Automatic registered artifact, but UI e2e suite did not pass for this head** (`uiE2ePassed` is `false`/unknown) → gate blocks with the same action, reason that the suite must run and pass first.
- **Non-UI change** → `required: false`, gate passes through untouched.

The detect layer reads the changed-file set from `gh pr view --json files` and derives `uiE2ePassed` from the `statusCheckRollup` UI e2e check(s) (`UI_E2E_CHECK_NAMES`). Every present UI e2e check must be `SUCCESS`. If none is present, the value is unknown and the gate fails closed.

Each automatic rendered-artifact family has a satisfiable CI job in `.github/workflows/ci.yml`. The `changes` job path-conditions each one, and each is named to match `UI_E2E_CHECK_NAMES`:

- `viewer-smoke` → inspect-run viewer spec (triggered by the viewer source set).
- `deck-smoke` → both presentation deck fit specs (triggered by `docs/presentations/**` and the deck specs/harness/configs).
- `article-smoke` → both article fit specs (triggered by `docs/articles/**` and the article specs/harness/configs).

### User-authorized manual-only workflow browser coverage

The twelve generated Simulator workflow examples remain registered rendered articles, but the user exempted their slow `workflow-examples` browser suite from automatic CI. `packages/core/src/loop/ui-e2e-scoping.mjs` owns that scheduling policy. Default and broad article Playwright discovery, automatic article-smoke, UI browser-gate requirements and targeted validation recommendations do not select this suite. Model/publication changes retain rendered-artifact and independent Designer review scope; automatic targeted validation selects fast script/model/publication tests instead. Package, documentation and generated-asset checks remain enabled.

Run `bun run test:playwright:workflow-examples` explicitly for local/manual browser proof; its existing `PW_UI_SLICE=workflow-examples` opt-in enables the project. `--list` discovers the suite without executing browsers. The original Detailed and Overview browser suites stay automatic; shared `simulator.html` changes still require original Detailed coverage, with workflow browser proof available manually. Source-supported facts, private/unverified summaries and proposed models keep their existing evidence boundaries. This is a browser scheduling exception, not a review, observed-defect, full-validation or merge-gate waiver. See the [Simulator workflow guide](https://github.com/mfittko/dev-loops/blob/main/docs/simulator-workflows.md) for the runtime and proof contract.

## Verifying a UI change: render and look, but don't persist ad-hoc checks

When you change a rendered artifact's layout, **verify it visually before merging**. Render the built page and inspect real geometry at desktop and mobile widths: `getBoundingClientRect` for edges and widths, and a full-page screenshot to look at it. This intermediary e2e pass is a required *verification strategy*. A layout claim is credible only once it is measured against the rendered page.

Do not persist these checks. The shared fit/CSP suite (`defineArticleSuite`/`defineDeckSuite`) is the registered coverage. Do not grow it with one-off pixel or alignment assertions for a single fix. Use a throwaway script to render, measure and screenshot while iterating, then drop it.

## An assertion must be able to fail on the defect

Before trusting any UI assertion, confirm it **fails on the defect**. Run it against the broken layout, or inject the defect (for example shift one block's left edge) and check that the assertion goes red. An assertion that cannot fail on the bug it names is not coverage. Prefer asserting the invariant that defines "correct" (for example all content blocks share one left edge within tolerance) over a correlated proxy.

## Non-goals

Not always-on screenshot testing; not mandatory multi-browser. The criterion is only the conservative path-glob + registry-membership + passing-coverage check.
