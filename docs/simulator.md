# Published dev-loops Simulator

The Pages **Simulator** navigation opens `simulator-overview.html`, the original lifecycle teaching view. Its paired links place Overview before Detailed. `simulator.html` remains the stable detailed view, including its original sub-loops, scenarios, starting conditions and execution controls. State atlas remains at `state-atlas.html`, linked from the Detailed footer as diagrams generated from code tables.

## Source and behavior boundary

These are teaching models, not a port or live execution of dev-loops. The original artifacts were derived from repository snapshot `c00aa769fab54d9c02ca69504009d0261bd870e7`; the HTML files were **not tracked at that commit**. Their initial publication imported the following original artifacts:

| Artifact | SHA-256 |
|---|---|
| `dev-loops-model.md` | `65bf8aee1ab7297c4c5ef15d7b693146758719cfd18cf71bda61313d0c5d899b` |
| `dev-loops-simulator.html` | `18a4d877c6fa7153b5bce3e27ed9280ff9064fc4119733785c087839f17eec97` |
| `overview.html` | `de4e22dd5ef2319e0c0a145eb191cc3cdcc507cbb5fa3f18f9438e8565b30305` |

The publication retains each artifact's teaching prose, graph/model tables, transitions, scenarios and defaults. Approved changes include complete HTML wrappers, published links, Overview-first navigation, Simulator-only navigation alignment/spacing, accessibility repairs and model extraction. The Detailed runtime still uses its original shared scratch initializer, nested caller/return protocol and Back/Reset semantics. Changing a starting condition retains the original reset-to-Custom behavior.

The native models live in `docs/articles/assets/simulator-model.mjs` and `docs/articles/assets/simulator-overview-model.mjs`. Both export `createModel()` but preserve distinct schemas: Detailed exposes nested graphs and `H(s, w, f, ret)` handlers; Overview exposes its lifecycle record and `advance(state, world, previous)` transition. Model instances own fresh graph/record/fact data. The pages import their models while retaining DOM rendering, controls, undo history and keyboard handling. The publisher emits both modules under `assets/`; the npm allowlist includes both for installed Node consumers. Model-only changes require their owning original page's automatic desktop/mobile suite.

Overview transition helpers are defined once per model and receive the run state explicitly; advancing a step does not recreate those helpers.

Extraction changes source location and bootstrap imports, not teaching semantics. Differential browser evidence compares every native preset's initial, completed, Back, replay and Reset states against the original artifacts. Full-window and graph-sizing scripts remain identical to the originals.

## Navigation and accessibility

The site menu aligns with each Simulator's overall content container, with a separate gap above the paired view links: 24px on desktop and 16px on mobile. The background remains full-width, unrelated page navigation is unchanged, and the original graph-sizing and full-window controls remain intact.

Both pages retain readable light/dark palettes, labeled keyboard-focusable traces and a main landmark. The Detailed SVG exposes its sub-loop buttons as interactive graph content rather than a flattened image. Its named graph scroll region supports four-arrow panning, including manually opened leaf graphs and full-window mode, without stepping or rewinding execution. The Overview remains its original static lifecycle image. Outside graph/trace regions, the established Next, Back, Reset and full-window shortcuts are unchanged.

## Targeted contributor checks

Use repository-pinned Bun 1.4.1. Node >=24 remains the consumer/site-builder runtime.

```sh
bun scripts/run-bun-test.mjs test/pages/build-site.test.mjs
bun scripts/run-bun-test.mjs test/pages/simulator-models.test.mjs
bun scripts/run-bun-test.mjs test/packaged-install-smoke.test.mjs
bun scripts/run-bun-test.mjs packages/core/test/ui-e2e-scoping.test.mjs packages/core/test/validation-classify.test.mjs test/loop/rendered-artifact-ci-changes.test.mjs test/loop/playwright-config-generation.test.mjs
bun run test:playwright:simulator-article
bun run test:playwright:simulator-overview-article
node scripts/pages/build-site.mjs --out /tmp/dev-loops-simulator-site
```

Both original browser suites remain automatically registered and scheduled in article CI. They exercise desktop/mobile layout, graph/trace keyboard interaction, stepping, Back replay, Reset and completion, using controlled local fallback fonts to avoid external Google Fonts variability. The publication test builds actual output and checks its exact resource set. Request any full-repository validation only through the canonical `dev-loops gate resolve-validation` interface, bound to the exact head.

Native model regressions cover unknown validation, the medium-fix window boundary, inline-review escalation, missing-lens retry precedence and a moved merge head. Installed-package smoke exercises both modules' real transitions under consumer Node.
