# UI validation contract under `dev-loop`

This document defines what UI end-to-end (e2e) coverage asserts under `dev-loop` and walks one artifact through the gate. The earlier opt-in, annotation-driven convention (issue #97 follow-up) is **superseded**. Inclusion is **path-triggered, registry-backed, and fail-closed** (UI-e2e epic: UE1 #975, UE2 #976).

## When UI e2e is required (auto-scoping, not opt-in)

A PR must carry passing UI e2e coverage when its changed-file set touches a rendered artifact. An annotation in a phase doc or PR description does not opt a PR in or out. [UI e2e scoping step](./ui-e2e-scoping-step.md) owns the criterion: globs, registries, fail-closed semantics and the satisfiable CI jobs. The membership list lives in `packages/core/src/loop/ui-e2e-scoping.mjs`, and the gate precondition `ui_e2e_scoping` in `packages/core/src/loop/pr-gate-coordination.mjs` enforces it.

## What the shared harness asserts

Required coverage runs the **shared** Playwright harness (`test/playwright/harness/deck-fit-harness.mjs` for decks and articles, `test/playwright/harness/inspect-run-viewer-harness.mjs` for the viewer), not a per-slice spec. For decks and articles the shared assertions are:

- every registered section renders and is visible (decks only);
- a Content-Security-Policy `<meta>` is present and locks `default-src` to `'none'`;
- the **mobile (390×844) layout fits**: no element overflows the viewport (for articles, elements inside an intentional `overflow-x:auto/scroll` container are exempt), the page `scrollWidth` does not exceed it, and no section clips content vertically;
- a negative control: a deliberately-wide element must fail the mobile fit check.

These responsive-fit assertions subsume the standalone slide responsive-fit goal (issue #939).

## Worked example: the intro deck

End to end for `docs/presentations/introducing-dev-loops.html`:

1. **Registered.** It is `DECK_REGISTRY["intro-deck"]` in `test/playwright/harness/deck-fit-harness.mjs` (`deck: "introducing-dev-loops.html"`, section ids `hero`…`close`, mobile capture `compounding`). The thin spec `test/playwright/intro-deck.spec.mjs` reads the entry via `deckRegistryEntry("intro-deck")` and passes it to `defineDeckSuite` with an absolute `deckPath` resolved against `docs/presentations/`. Its full repo-relative path appears in `REGISTERED_ARTIFACT_PATHS`.
2. **Assertions it runs.** `defineDeckSuite` runs the shared assertions above: section visibility, CSP-meta lock, mobile fit and the wide-element negative control.
3. **Gate requirement.** A PR that edits the deck is auto-scoped. The `ui_e2e_scoping` precondition requires passing UI e2e coverage for the PR head. An unregistered deck fails closed with `nextAction: run_ui_e2e_suite`. A registered deck requires the UI e2e check to be `SUCCESS`.
4. **Satisfiable CI signal.** The `deck-smoke` CI job in `.github/workflows/ci.yml` runs both deck fit specs and is named to match `UI_E2E_CHECK_NAMES`. Its `SUCCESS` is the signal the gate reads. Locally the same suite runs via `bun run test:playwright:intro-deck`; that package script deliberately launches Playwright with Node.

The article path is identical with `ARTICLE_REGISTRY["intro-article"]` (`docs/articles/introducing-dev-loops.html`), `defineArticleSuite` and the `article-smoke` job. The same-named deck and article are distinct registrations keyed on full path.

## Non-goals

UI validation is not always-on screenshot testing and does not mandate multi-browser coverage. [UI Smoke Harness](./ui-smoke-harness.md) and [UI Artifact Contract](./ui-artifact-contract.md) own the WebKit config and the named-state artifact shape. [UI Designer Review Loop](./ui-designer-review-loop.md) owns the required recorded-evidence review pass (ADR 0041, issue #1443), which is distinct from this e2e smoke gate.
