# UI validation contract under `dev-loop`

This document defines the UI validation contract under `dev-loop`: when UI
end-to-end (e2e) coverage is required, what it asserts, and how the gate enforces
it. The original slice (issue #97 follow-up) made UI validation an opt-in,
annotation-driven convention. That convention is **superseded**: inclusion is now
**path-triggered, registry-backed, and fail-closed** (UI-e2e epic — UE1 #975
shipped the shared harness, UE2 #976 made it required).

## When UI e2e is required (auto-scoping, not opt-in)

UI e2e coverage is **not** opted into by annotating a phase doc or PR description.
A PR is required to carry passing UI e2e coverage when its **changed-file set**
touches a registered rendered artifact, matched against explicit globs:

- a presentation deck — `docs/presentations/*.html`
- an article page — `docs/articles/*.html`
- the inspect-run viewer source — `scripts/loop/inspect-run-viewer.mjs`

This is deterministic and conservative: single-segment `*.html` globs (no
recursion) plus the viewer source path. A PR that touches none of these is not a
UI change and the gate passes through.

The canonical owner of this criterion — globs, registries, fail-closed semantics,
and the satisfiable CI jobs — is the standard step doc
[UI e2e scoping step](../skills/docs/ui-e2e-scoping-step.md). The deterministic
membership list lives in `packages/core/src/loop/ui-e2e-scoping.mjs`, and the gate
precondition `ui_e2e_scoping` in `packages/core/src/loop/pr-gate-coordination.mjs`
enforces it.

## What the shared harness asserts

Required coverage runs the **shared** Playwright harness
(`test/playwright/harness/deck-fit-harness.mjs` for decks and articles,
`test/playwright/harness/inspect-run-viewer-harness.mjs` for the viewer), not a
per-slice spec. For decks and articles the shared assertions are:

- every registered section renders and is visible (decks only);
- a Content-Security-Policy `<meta>` is present and locks `default-src` to `'none'`;
- the **mobile (390×844) layout fits** — no element overflows the viewport, page
  `scrollWidth` does not exceed it, and no section clips content vertically;
- a negative control: a deliberately-wide element must fail the mobile fit check.

These are the responsive-fit assertions that subsume the standalone slide
responsive-fit goal tracked in issue #939.

## Worked example: the intro deck

End to end for one real artifact — `docs/presentations/introducing-dev-loops.html`:

1. **Registered.** It is `DECK_REGISTRY["intro-deck"]` in
   `test/playwright/harness/deck-fit-harness.mjs` (`deck:
   "introducing-dev-loops.html"`, section ids `hero`…`close`, mobile capture
   `compounding`). A thin spec — `test/playwright/intro-deck.spec.mjs` — calls
   `defineDeckSuite(DECK_REGISTRY["intro-deck"])`, and its full repo-relative path
   appears in `REGISTERED_ARTIFACT_PATHS` (a sync test keeps that list aligned with
   the registry).
2. **Assertions it runs.** `defineDeckSuite` runs the shared assertions above over
   the deck: section visibility, CSP-meta lock, mobile fit, and the wide-element
   negative control.
3. **Gate requirement.** A PR that edits `docs/presentations/introducing-dev-loops.html`
   is auto-scoped: the `ui_e2e_scoping` precondition requires passing UI e2e
   coverage for the PR head. If the deck were not registered, the gate **fails
   closed** with `nextAction: run_ui_e2e_suite`; because it is registered, the gate
   requires the UI e2e check to be `SUCCESS`.
4. **Satisfiable CI signal.** The `deck-smoke` CI job in `.github/workflows/ci.yml`
   runs both deck fit specs (path-conditioned on `docs/presentations/**` and the
   deck specs/harness/configs) and is named to match `UI_E2E_CHECK_NAMES`. Its
   `SUCCESS` is the signal the gate reads. Locally the same suite runs via
   `npm run test:playwright:intro-deck`.

The article path is identical with `ARTICLE_REGISTRY["intro-article"]`
(`docs/articles/introducing-dev-loops.html`), `defineArticleSuite`, and the
`article-smoke` job. The same-named deck and article are **distinct** registrations
keyed on full path and never alias onto each other.

## Non-goals

UI validation is still not always-on screenshot testing and does not mandate
multi-browser coverage. The criterion is only the conservative path-glob +
registry-membership + passing-coverage check. The reusable named-state artifact
shape and the WebKit config the shared harness builds on are documented in
[UI Smoke Harness](./ui-smoke-harness.md) and [UI Artifact Contract](./ui-artifact-contract.md);
the optional designer/vision review loop that consumes those artifacts is in
[UI Designer Review Loop](./ui-designer-review-loop.md).
