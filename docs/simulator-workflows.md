# Simulator workflow examples

The primary published entrypoint is `simulator-overview.html`. Its visible workflow-examples link opens the common **Agent workflow examples** chooser on `simulator.html#examples`, with all twelve separate `workflow-<slug>.html` pages. Overview is the first/left paired view, Detailed the second/right; both stable URLs retain their original models and default scenarios. Each example includes its concrete lifecycle, shared detailed controls, live records and trace, actor annotations, and a source/reference section. `state-atlas.html` remains available. No archive page, navigation or output is published.

Simulator-family header navigation and the overall content container share the view's width token, preserving its gutters, full-bleed background and normal link gaps. A separate vertical gap keeps the paired-view controls below the header divider (24px desktop, 16px mobile). This scoped layout does not change unrelated Pages navigation, fullscreen graph bounds, models or default scenarios.

## One original runtime

`docs/articles/simulator.html` is the only detailed Simulator runtime/template. `scripts/pages/workflow-examples.mjs` selects the curated profiles and supplies example titles, modeled-workflow context, sources and boundaries to that template. `scripts/pages/build-site.mjs` publishes each route and its selected module through the existing article/navigation pipeline. Generated example HTML is not separately maintained.

Each `docs/articles/assets/workflow-models/<slug>.mjs` exports `createModel()`, returning fresh `MODEL`, `I`, `GR`, `ORDER`, `F`, `SC`, `world`, `defaults`, and `H` data/functions. The entrypoint selects this profile only when an example page has `data-workflow`; the original route keeps its original model, defaults, scenarios, conditions and roles. Example metadata supplies record fields, budgets, actor annotations, hypothetical presets, sources, evidence status and research version. No real agents, tools, mutations, studies, metrics, payment or backend integrations execute.

The engine invokes `H[g][node](records, world, sharedScratch, returnedOutcome)`. A string advances inside a graph; `END` completes the whole run. `{ sub, at }` saves the current caller position and enters a child. `{ up, via }` returns to that **same caller**, which consumes the returned outcome on its next invocation. There is one shared `S.f`, not one scratch object per stack frame. Original runs retain their existing scratch initializer; examples start with `{}`.

Example conditions remain editable during execution. Editing does not silently reset execution or supply human authority. An unanswered human contribution remains **WAIT**; Next/Run/polling cannot consent, and Run stops at the wait. Explicit contributions can resume the waiting step. Back restores the entire execution record, stack, pending result and shared scratch; current editable inputs are not historical. Reset keeps those current inputs. Choosing a scenario restores its hypothetical starting inputs. The expandable **Runtime inspection** is live state, not a prerecorded trace.

For examples, graph text renders at 100% initial scale and the horizontally scrollable camera centers the active/entry node; original camera behavior is unchanged. Long evidence/context and condition labels wrap. Long select choices remain available in their dropdowns.

## Curated selection and evidence

The selected profiles are Conveyor belt, Collaborative grilling, Magentic-UI, Open SWE (published 2025), QA Wolf Mapping AI, Playwright test agents, Meta ACH, EvalGen, UXAgent, Conversational UX co-analysis, Mobile checkout improvement (`product-design-frontend`) and Production incident response (`incident-response`). Checkout is an explicitly proposed Product/Design/Frontend workflow with human built-UI review, state/version-bound rechecks, code/design/product feedback, release and hypothetical outcome learning. Incident response preserves five nested diagnosis/evidence/remediation/verification graphs, parent rollback and all ten scenarios; deployment-specific human authorization and illustrative global/local budgets are proposed, not a live production-system integration.

`simulator-workflow-sources.md` rehomes selected point-in-time research notes. `simulator-workflow-provenance.json` records every frozen source SHA256, production asset SHA256, adaptations and exclusions. Each published reference section visibly separates **source facts/provided context**, **graph abstraction**, and **proposed extensions**. Private Google Docs are unverified provided summaries; author-reported claims are not local replications. Strateegia, Stripe Minions, the nine other cross-industry models, old agent-loop/agent-task atlas assets, the spike assembler/engine and frozen original Simulator are not production inputs.

## Targeted verification

Use repository-pinned Bun 1.4.1. Node >=24 remains the consumer/site-builder runtime.

```sh
bun scripts/run-bun-test.mjs test/pages/build-site.test.mjs test/pages/workflow-examples.test.mjs packages/core/test/ui-e2e-scoping.test.mjs test/loop/rendered-artifact-ci-changes.test.mjs
bun scripts/run-bun-test.mjs test/pages/conveyor-belt.test.mjs test/pages/collaborative-grilling.test.mjs test/pages/nested-workflow-budgets.test.mjs
bun run test:playwright:workflow-examples --grep 'conveyor-belt'
bun run test:playwright:workflow-examples --grep 'meta-ach|playwright-test-agents|qa-wolf-mapping-ai|conversational-ux-coanalysis'
bun run test:playwright:workflow-examples
bun run test:playwright:simulator-article
bun run test:playwright:simulator-overview-article
node scripts/pages/build-site.mjs --out /tmp/dev-loops-workflow-site
```

The required `workflow-examples` WebKit slice builds actual site output. On 1280px desktop and 390px mobile it exercises every profile's completion, rework and explicit-human wait, child invocation/return/same-caller consumption, Back replay of returned results and completion, reset, keyboard graph/trace controls, source links and chooser/reciprocal navigation. Named light/dark captures, console observations, bounds and axe results follow the existing UI artifact convention. Required UI scoping and rendered-artifact CI treat changes to profile modules or their publication renderer as article changes, even without a changed HTML file. This targeted proof does not replace fresh expanded-head full validation or PR gates.

Checkout paths also distinguish a local frontend code repair from Design revision and fresh Product scope authority. Rechecks inspect the current built version; unchanged commercial and instrumentation decisions survive affected revisions. Insufficient post-release evidence ends in human handoff, not an invented successful outcome. Changes to the shared detailed runtime require both original and generated-workflow UI coverage.

Incident-response coverage retains scenarios 1–10: local hypothesis and sandbox rework, rollback/re-diagnosis with fresh deployment-specific approval, access handoff, denied authorization, bounded unrecovered service, evidence recollection and health resampling. Missing, stale or premature authorization cannot spend a deployment or permit an apply; Back restores consumed approval and counters without changing live inputs.

Collaborative Grilling's production decision selectors name proposals 1–3 explicitly. A revised scope decision and joint resolution must match the current proposal; pending or stale values leave the affected records unresolved without spending budgets. Unchanged knowledge, exclusions, accepted risk and dissent retain their provenance. This intentional production guard repair is recorded separately from the frozen producer source.

Conveyor's design evidence must name the current design version; editorial readiness and the joint source-sheet check must name the current initiative version. Native positive inputs cover every initiative version 1–4. Pending or stale inputs WAIT without spending budgets. Technical-only revisions retain independent stakeholder/design decisions; direction reshape retains unaffected technical evidence. A new technical CALL resets its shared invocation-local probe count, while local loops, return consumption and retained evidence leave it alone. Desktop/mobile regressions exercise stale/current native contributions, exact Back replay across new CALLs and input resumes, two probes in each capped invocation, and preparation/interpretation through initiative 4. These intentional production repairs do not alter the original teaching model or frozen upstream provenance.

Meta ACH's revised concern contribution names concern 2 or 3: a consumed concern-2 answer cannot author concern 3 after another no-survivor return. Each new Meta test CALL and Playwright healer CALL initializes its shared invocation-local counter; internal repair and return consumption do not reset it or the global concern/intent cap. A newly supplied co-analysis question initializes the visible explanation count with its scratch counter, retaining earlier questions, rejected findings and exclusions. Native desktop/mobile paths cover stale/current authorship, independent two-candidate/repair allowances, capped invalid evidence, pending questions and exact Back replay across new CALLs and input resumes.

Product/Design/Frontend's global budget counts artifact revisions, not denied requests. After two revisions, both a further Design iteration and a Product reshape hand off without creating version 3, spending a phantom third revision or erasing current research, inspection, release and learning evidence. Native desktop/mobile regressions traverse both complete outcome-learning paths and replay the cap boundary; allowed version-1-to-2 invalidation is unchanged.

Actor annotations describe the work actually represented, not a requirement to make every row nonzero. QA Wolf's conventional exact-ID/version matcher is code, not an LLM correspondence verdict. Conveyor represents stakeholder/design/editorial judgments from an unverified provided process; EvalGen leaves sample calibration to human graders without an invented scoring algorithm; UXAgent represents agent inspection of hypothetical connector context rather than an automated schema validator; Conversational UX represents human source inspection and assistant explanation rather than recording-playback code; Incident response represents scoped investigation/remediation orchestration and human authorization rather than an independently modeled conventional code driver. These retain their human/agent roles instead of relabeling generic guards or human judgment as code.

The detailed graph scroll area is a named keyboard-focusable region, including leaf graphs and full-window display. Its four arrow keys use native DOM scrolling on the actual overflow owner without stepping execution or Back; this also works where WebKit's default arrow action does not pan. Other established shortcuts remain unchanged.
