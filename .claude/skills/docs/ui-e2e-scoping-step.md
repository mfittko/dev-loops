# UI e2e scoping step

Canonical owner for **when the shared UI/mobile e2e loop is required**. Inclusion
is **path-triggered and deterministic** — it does not depend on a human annotating
the PR or a phase doc.

## Trigger: a rendered-artifact change requires UI e2e coverage

A PR that **adds or modifies a rendered HTML artifact** MUST run the shared UI e2e
assertions (mobile + desktop) AND register that artifact in the e2e suite. A
"rendered artifact" is anything that renders to a served page or component:

- a presentation deck — `docs/presentations/*.html` (registered in `DECK_REGISTRY`)
- an article page — `docs/articles/*.html` (registered in `ARTICLE_REGISTRY`; the
  intro article is the published landing page)
- the inspect-run viewer's served page/component — `scripts/loop/inspect-run-viewer.mjs`

The trigger is the PR's **changed-file set** matched against these explicit globs.
It is conservative on purpose (issue #976 scope): only artifacts that render to a
page/component, matched by exact directory + single-segment `*.html` globs (no
recursion) and the viewer source path.

Registration is keyed on the **full repo-relative path**, not the basename, so
`docs/articles/X.html` and `docs/presentations/X.html` (which share basenames,
e.g. `introducing-dev-loops.html`) are **distinct** artifacts and can never alias
onto each other — editing the article never counts as deck coverage and vice versa.

### Examples — required

- `docs/presentations/introducing-dev-loops.html` edited → UI e2e **required**
  (deck-smoke CI job runs the deck fit specs).
- `docs/articles/introducing-dev-loops.html` (the landing page) edited → UI e2e
  **required** (article-smoke CI job runs the article fit specs); it is its own
  registration, NOT covered by the same-named deck.
- A new `docs/articles/new-page.html` added → UI e2e **required**, and because the
  new page is not yet in `ARTICLE_REGISTRY` the gate **fails closed** until it is
  registered (add an entry + a thin spec calling `defineArticleSuite`).
- `scripts/loop/inspect-run-viewer.mjs` edited → UI e2e **required** (the viewer is
  registered in `VIEWER_REGISTRY`).

### Examples — not required

- `packages/core/src/loop/copilot-loop-state.mjs`, `README.md`, `*.test.mjs`,
  `docs/articles/foo.md` (not `.html`), or a nested `docs/articles/sub/x.html`
  (the glob is single-segment) → UI e2e **not required**; the gate passes through.

## Register the artifact in the suite

"Registered" means the artifact appears in the shared registries:

- decks → `DECK_REGISTRY` in `test/playwright/harness/deck-fit-harness.mjs`
  (served from `docs/presentations/<deck>`) with a thin spec calling `defineDeckSuite`.
- articles → `ARTICLE_REGISTRY` in `test/playwright/harness/deck-fit-harness.mjs`
  (served from `docs/articles/<file>`) with a thin spec calling `defineArticleSuite`
  (shared fit/CSP/no-horizontal-scroll assertions, minus the deck's per-section
  named captures).
- the viewer → `VIEWER_REGISTRY` in
  `test/playwright/harness/inspect-run-viewer-harness.mjs`.

The deterministic membership list the gate checks against lives in
`packages/core/src/loop/ui-e2e-scoping.mjs` (`REGISTERED_ARTIFACT_PATHS`, keyed by
full repo-relative path; `VIEWER_ARTIFACT_ID`). A sync test keeps
`REGISTERED_ARTIFACT_PATHS` from drifting from `DECK_REGISTRY` + `ARTICLE_REGISTRY`;
the single-valued `VIEWER_ARTIFACT_ID` is not import-checked against `VIEWER_REGISTRY`
(that harness pulls `@playwright/test` into core), so keep the two in sync by hand.

## Fail-closed semantics

The check is wired as a gate precondition in `evaluatePrGateCoordination`
(`packages/core/src/loop/pr-gate-coordination.mjs`), at a seam distinct from the
mergeability (#980) and retrospective (#982) preconditions. It fails closed:

- **Unregistered rendered artifact touched** → gate blocks with
  `nextAction: run_ui_e2e_suite`, reason naming the artifact and that it needs
  registration in the suite.
- **Registered, but UI e2e suite did not pass for this head** (`uiE2ePassed` is
  `false`/unknown) → gate blocks with the same action, reason that the suite must
  run and pass first.
- **Non-UI change** → `required: false`, gate passes through untouched.

The detect layer reads the changed-file set from `gh pr view --json files` and
derives `uiE2ePassed` from the `statusCheckRollup` UI e2e check(s)
(`UI_E2E_CHECK_NAMES`): present UI e2e checks must all be `SUCCESS`; if none is
present the value is unknown and the gate fails closed.

Each rendered-artifact family has a stable, satisfiable CI job in
`.github/workflows/ci.yml`, path/diff-conditioned in the `changes` job and named
to match `UI_E2E_CHECK_NAMES` so the gate can read a real signal:

- `viewer-smoke` → inspect-run viewer spec (triggered by the viewer source set).
- `deck-smoke` → both presentation deck fit specs (triggered by
  `docs/presentations/**` and the deck specs/harness/configs).
- `article-smoke` → both article fit specs (triggered by `docs/articles/**` and the
  article specs/harness/configs).

So a deck- or article-only PR has a CI check that can actually satisfy the gate;
without these jobs such a PR would fail closed with no satisfiable signal.

## Non-goals

Not always-on screenshot testing; not mandatory multi-browser. The criterion is
only the conservative path-glob + registry-membership + passing-coverage check.
