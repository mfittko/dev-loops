# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- **Presentation decks publishable to GitHub Pages** (#930). `.github/workflows/pages.yml` runs the standard Pages pipeline (`actions/configure-pages` + `actions/upload-pages-artifact` + `actions/deploy-pages`, with `permissions: { pages: write, id-token: write, contents: read }` and `concurrency: { group: pages }`). A committed, reusable build script (`scripts/pages/build-site.mjs`, exported `buildSite`/`DECKS`) deterministically assembles `site/` — copying the self-contained deck renders (`docs/presentations/applied-dev-loops.html`, `process-observability.html`) and generating a CSP-safe dark-aesthetic `site/index.html` linking both. The deck HTML stays the single source of truth; `site/` is assembled (gitignored), never hand-maintained. The **build** job (assemble + upload, which validates the assembly) runs on push to `main` + `workflow_dispatch`, while the **deploy** job is gated to `workflow_dispatch` (`if: github.event_name == 'workflow_dispatch'`) so a push to `main` never turns red while Pages is disabled — an operator enables Pages (Settings → Pages → Source: GitHub Actions) and runs the workflow once. `docs/presentations/README.md` documents the decks, local viewing, the deploy flow, the one-time operator step, and the private-repo plan caveat (a public Pages site from a private repo needs Pro/Team/Enterprise; until enabled the deploy job is a no-op). Also adds the missing `@media (prefers-reduced-motion: reduce)` guard to `applied-dev-loops.html` for parity with the observability deck (disables `scroll-behavior: smooth` on `html`, `scroll-snap-type` on `body`, `scroll-snap-align` on `.slide`). A `node:test` spec (`test/pages/build-site.test.mjs`) asserts the build produces `index.html` + both decks and that the index links both.
- **Slides content & storytelling review loop formalized as a bounded reviewer mode** (#929). A sibling of the [UI Designer + Vision Review Loop](docs/ui-designer-review-loop.md) behind `dev-loop` that judges a deck's *narrative*, not its pixels — "does it land?" rather than "does it look right?". `docs/slides-story-review-loop.md` defines the contract: the public entrypoint/dependency boundary (no new public name), a fail-closed REQUIRED INPUT BUNDLE (deck source path + slice-level acceptance criteria + a short storytelling brief + optional captured slide screenshots from the UI smoke harness), the public-audience REVIEW LENS (arc/hook/close, one message per slide + claim titles, sequencing/no-forward-refs, jargon translation, cut/merge/reorder), and a REQUIRED OUTPUT BUNDLE (findings + corrective actions + a single structured outcome `story_review_satisfied` | `needs_iteration`). The pure module `scripts/loop/slides-story-review-contract.mjs` exports the outcome constants plus a fail-closed input-bundle validator and a result-shape validator (no I/O); the prompt template lives at `skills/dev-loop/templates/slides-story-review.md`. The two inline applications already run over the decks are recorded as the first two runs (`docs/presentations/applied-dev-loops-review-notes.md` #926, `docs/presentations/process-observability-review-notes.md` #927). Cross-linked from the UI loop doc, the README, and `docs/index.md`.
- **Process Observability deck refreshed + a self-contained shareable HTML render** (#927). `docs/presentations/process-observability-presentation.md` (Slidev) is restructured into one 9-slide public-audience story arc in the existing dark glass-card style: claim-style titles, one message per slide, jargon trimmed (`task state` / `pipeline latency` pills cut), the two overlapping handoff-cost slides merged, and a memorable close (*"Stop optimizing how fast you write code. Start measuring how long it waits."*) replacing the bare metric grid. A new grounding slide (`instrumented`) ties the abstract "observable state cuts delay" claim to what actually exists — the queue board lifecycle (owner / safe next step), the gate evidence trail (latest decision + findings), the deterministic next-action resolver, and "automate only where state supports safe continuation" via provider-agnostic CI waits and operator-induced post-merge worktree reclaim / long-done archival — in plain language, no version labels or raw identifiers. A standalone, CSP-safe `docs/presentations/process-observability.html` ships the full deck with all CSS inline (ported from `style.css`: navy gradient, glass cards, violet accent, blue kicker, mono pills) and the flowcharts rendered as inline CSS/HTML flow (no mermaid/CDN, no remote resources) — each slide is a stable-id `<section>` (`hero`, `interrupt-cost`, `handoff`, `blind-spot`, `observable-state`, `measurement-loop`, `instrumented`, `metrics`, `close`). A thin WebKit smoke spec (`test/playwright/observability-deck.spec.mjs` + `playwright.observability-deck.config.mjs`, `npm run test:playwright:obs-deck`) asserts every named section is present with no body horizontal overflow and captures the `hero`, `interrupt-cost`, `observable-state`, `measurement-loop`, `instrumented`, `metrics`, and `close` states under `test-results/ui-smoke/observability-deck/`; one designer/vision review pass (notes in `docs/presentations/process-observability-review-notes.md`, storytelling + visual sections) confirmed equal-height cards, legible flow diagrams, and a landing close with no corrective CSS required beyond the ported baseline.
- **Applied dev-loops deck refreshed for v0.4.0 + a self-contained shareable HTML render** (#926). `docs/presentations/applied-dev-loops-presentation.md` (Slidev) gains two slides in the existing dark glass-card style: the **gate fan-out/fan-in sub-loop** (build-once neutral bundle = full diff + 1-hop import adjacency, size-guarded; independent per-angle reviewers seeded with the identical bundle; `consolidateFanin` merges per-angle verdicts; no fork primitive / no Workflow dependency; fail-closed `fanout_fanin` verdict with enforced severity counts) and **the coordination runtime owning the full lifecycle** (enforced human merge via `autonomy.humanMergeOnly`, managed `tmp/worktrees/dev-loops/` worktrees, provider-agnostic `watch-ci`, queue board as a deterministic adapter). A standalone, CSP-safe `docs/presentations/applied-dev-loops.html` ships the full deck with all CSS inline and the mermaid diagrams rendered as inline CSS flow (no font/mermaid CDN, no remote resources) — each slide is a stable-id `<section>` for UI smoke targeting. A thin WebKit smoke spec (`test/playwright/applied-deck.spec.mjs` + `playwright.applied-deck.config.mjs`, `npm run test:playwright:deck`) captures the `hero`, `core-idea`, `parallel-review`, `trust`, and `impact` named states under `test-results/ui-smoke/applied-deck/`; one designer/vision review pass (notes in `docs/presentations/applied-dev-loops-review-notes.md`) fixed ragged card heights via equal-height grid rows. A follow-up **public-audience storytelling pass** restructured the deck to one ~8-slide narrative arc (claim-style titles, jargon translated to plain language, raw enum/pill walls cut to at most one identifier per slide as evidence, mechanism→outcome close) while keeping the dark glass-card visual identity unchanged.

### Fixed

- **Decks fit the phone screen — no horizontal scroll, no clipped content (~390px)** (#937). On a phone the inline flow diagram (`.flow { min-width: max-content }`, `.node { white-space: nowrap }`) forced its grid track wider than the viewport, and `.slide { overflow: hidden }` then **clipped** anything taller than one screen (bullets cut mid-word, flow nodes sheared, slide bottoms cut off). The requirement is that content **fits** both dimensions, not that it scrolls inside a card. Fix (both `docs/presentations/applied-dev-loops.html` and `process-observability.html`): (1) **diagrams fit by stacking** — at `≤600px` `.flow` switches to `flex-direction: column` with arrows rotated to point down and `.node { white-space: normal }`, so the diagram lays out vertically and fits the width (measured 319px flow in a 319px card, zero internal scroll); `.flow { flex-wrap: wrap }` keeps desktop rows fitting too, and `.flow-scroll { overflow-x: auto }` is now a never-triggered last-resort safety, not the fix; (2) **no vertical clip** — `.slide { overflow: hidden }` → `overflow: visible` so a tall slide grows and the page scrolls between slides instead of cutting content off; (3) **mobile sizing** — a `≤600px` breakpoint reduces heading/card/padding scale and top-aligns slides so content fits comfortably. `min-width: 0` on grid children and `overflow-wrap: anywhere` on `p`/`li`/`code` are added. The CSS lives only in the HTML renders (the Slidev `*-presentation.md` sources carry none of it). The dark visual identity, section ids, CSP guard, and reduced-motion guard are unchanged. Both Playwright deck specs (`test/playwright/applied-deck.spec.mjs`, `observability-deck.spec.mjs`) are hardened to enforce **fit** at mobile (390×844): a settle barrier (`waitForLoadState("networkidle")` + `waitForFunction(innerWidth === 390)` + `document.fonts.ready`) removes the cold-start false-fail that measured desktop geometry; the horizontal check now fails if **any** element's `getBoundingClientRect().right > innerWidth + 1` (the `overflow-x:auto` scroller exemption is dropped — diagrams must fit) and asserts `document.scrollingElement.scrollWidth <= innerWidth + 1` (no horizontal page scroll); a vertical-clip check fails any section whose `clientHeight < scrollHeight` while `overflow-y` is `hidden`/`clip`; a guard-the-guard test confirms the fit check fails on a deliberately-wide element. Each spec also captures one mobile named state.

## 0.4.0

### Added

- **Opt-in human reviewer/assignee handoff at the pre-approval gate** (#920, pairs with #910). A new `approval.humanHandoff` config (`{ enabled (default false), candidatesFrom: ["codeowners"|"recent-committers"], assignees: [...] }`) plus `scripts/github/resolve-handoff-candidates.mjs` resolve a deduped, priority-ordered candidate list (configured `assignees` → CODEOWNERS last-match-wins for the PR's changed paths → recent committers via `git log`, excluding the PR author/bots; team handles flagged). `dev-loops gate offer-human-handoff --repo <o/n> --pr <n> [--assign <login>] [--request-review <login>]` prints the offer and, only on an explicit `--assign`/`--request-review` flag, runs `gh pr edit --add-assignee/--add-reviewer` — OFFER-only, never auto-assigns. Surfaced at the human-merge handoff so `autonomy.humanMergeOnly` routes the PR to a named human instead of parking silently. Disabled by default; fail-soft per source.
- **Provider-agnostic CI watcher `dev-loops loop watch-ci`** (#917). A block-waiting watcher (`scripts/github/probe-ci-status.mjs`) that polls a PR's combined check-run + commit-status state for the current head SHA until terminal or timeout — covering GitHub Actions, CircleCI, and any external commit-status/check-run, unlike Actions-only `gh run watch`. It short-circuits to `changed` when the head SHA advances mid-wait so the loop re-baselines. The no-checks path is race-safe: a fresh push where a provider (CircleCI/Actions) hasn't posted its first status yet is NOT settled green on the first poll — the watcher awaits a 2-consecutive-zero-check-poll grace before settling `none`→`success`, treats PR `statusCheckRollup`-expected-but-unreported checks as pending, and never fabricates green from a transient `gh api`/parse failure (an errored fetch forces pending; a persistent error settles `timeout`, never success).
- **`autonomy.humanMergeOnly` — fixed, non-overridable human-merge rule** (#910). Repos with a hard "a human must perform the merge" rule can now set `autonomy.humanMergeOnly: true` in `.devloops`, making merge an enforced repo invariant rather than a per-run default an explicit instruction can unlock. When set: `resolveAutonomyStopAt` always includes `merge` (even if `stopAt` is `[]`); the new authoritative gate `resolveEffectiveMergeAuthorized(mergeAuthorized, config)` fails closed — it returns `false` regardless of the `mergeAuthorized` envelope flag / explicit "merge" instruction — and the lifecycle resolver (`resolveLifecycleState`) therefore never advances to the terminal merge state, parking instead at the `pre_approval_gate` human-merge handoff. The agent still runs the full mechanical pre-merge evidence check and reports merge-ready, but never runs `gh pr merge` itself. The `queue run` path routes its `--merge-authorized` flag through the same gate. New resolvers `resolveHumanMergeOnly` / `resolveEffectiveMergeAuthorized` in `@dev-loops/core/config`; see [skills/docs/merge-preconditions.md](skills/docs/merge-preconditions.md).
- **Managed worktree lifecycle** (#909). dev-loops now owns the full worktree lifecycle through one shared canonical-path resolver. (1) **Namespaced naming:** loop-owned worktrees live at `tmp/worktrees/dev-loops/<kind>-<number>` (e.g. `issue-909`, `pr-908`) with no branch suffix, so the path is recomputable from the issue/PR number alone — `resolveWorktreePath({ repoRoot, kind, number })` (in `@dev-loops/core/loop/handoff-envelope`) is the single source of truth for create/provision/cleanup. (1a) **Lifecycle entrypoint:** `scripts/loop/ensure-worktree.mjs --repo-root <p> (--issue <n> | --pr <n>)` is the canonical create+provision command — it fetches the base remote, creates the worktree at the canonical path (or reuses one that already exists there, reporting a conflict instead of clobbering a different branch), then invokes the provisioning core in the same step, printing `{ ok, path, created|reused, provision }`. (2) **Auto-provisioning:** a new `.devloops` `worktree` section (`copyOnInit` / `linkOnInit`, both opt-in arrays of repo-relative literal paths or glob patterns) drives `scripts/loop/provision-worktree.mjs`, which copies (`fs.cp`) or absolute-symlinks the configured gitignored files/dirs from the main checkout into a fresh worktree — directories recurse, sources outside the main checkout are rejected, missing sources / empty globs fail soft, and reuse is idempotent. It does not run `npm install` and is not a `node_modules` mirror. (3) **Namespace-scoped cleanup:** `scripts/loop/cleanup-worktree.mjs` resolves the canonical path and runs `git worktree remove --force` + `git worktree prune` from the main checkout, refusing any path not under `tmp/worktrees/dev-loops/` and failing soft on git errors. See [docs/worktree-guidance.md](docs/worktree-guidance.md).
- **Consumer migration guide** (#769): [`docs/migrating-to-dev-loops.md`](docs/migrating-to-dev-loops.md) walks existing `pi-dev-loops` consumers through every breaking change — package name (`pi-dev-loops`→`dev-loops`, `@pi-dev-loops/core`→`@dev-loops/core`), repo slug, the full `PI_*`→`DEVLOOPS_*` env-var mapping (a deliberate clean break with no aliases), and the `.devloops` config location. Linked from the README. The env vars are not shimmed by design (`0.x`, YAGNI); the legacy `.pi/dev-loop/settings.yaml` config path still loads with a deprecation warning.

### Changed

- **Post-merge board archive is now a standard step of the post-merge hook** (#918). `archive-done-items.mjs` (applying `queue.archiveOlderThanDays`, default 7d) is wired into the canonical `merge-preconditions.md` "Post-merge" surface alongside worktree cleanup, and the copilot-pr-followup post-merge step is no longer framed as merely optional. Operator-induced (runs after merge); best-effort — the hook ignores a non-zero exit so a failed archive never blocks merge completion. NOT a cron/scheduled job.
- **Queue management surfaced under `dev-loops queue`** (#912). The queue board management commands (`add`, `list`, `reorder`, `move`, `sync-status`, `archive-done`, `ensure`) are now discoverable and runnable under `dev-loops queue <sub>` alongside the existing `queue run` — `dev-loops queue --help` lists them all with one-line descriptions. They delegate to the same `scripts/projects/*.mjs` implementations; `dev-loops project <sub>` is retained as a back-compat alias group (lowest-churn: the routing table is data-driven, so `queue` reuses the existing script mappings). Flag consistency: `queue add` now accepts `--column <name>` for the Status column (matching `queue list`), with `--status <name>` kept as a back-compat alias. `move`/`sync-status` keep their distinct `--to-column`. Removes the only reason to hand-write `gh api graphql` for queue work.
- **BREAKING: Node floor raised `>=20` → `>=24`** (#911). `engines.node` is now `>=24` in both `dev-loops` and `@dev-loops/core` (the latter previously declared no floor). CI already runs Node 24; this makes the supported floor explicit and unlocks Node 24 stdlib (e.g. native `fsp.glob`/`path.matchesGlob`). Consumers on Node < 24 must upgrade.
- **BREAKING: all `PI_*` environment variables renamed to `DEVLOOPS_*` — no aliases, no fallback** (#905). Completing the env-var neutralization left half-done by the rebrand (#763, surfaced in #769), every dev-loops-owned operational env var is now `DEVLOOPS_*`-only; the previous neutral-first alias pattern (which honored `PI_SUBAGENT_RUN_ID` / `PI_SUBAGENT_AVAILABLE` as fallbacks) is removed. This is a deliberate `0.x` breaking change — consumers must rename their env vars (migration covered by #769). Mapping: `PI_SUBAGENT_RUN_ID`→`DEVLOOPS_RUN_ID`, `PI_SUBAGENT_AVAILABLE`→`DEVLOOPS_SUBAGENT_AVAILABLE`, `PI_PREFLIGHT_BYPASS`→`DEVLOOPS_PREFLIGHT_BYPASS`, `PI_PREPUSH_BYPASS`→`DEVLOOPS_PREPUSH_BYPASS`, `PI_WORKTREE_BYPASS`→`DEVLOOPS_WORKTREE_BYPASS`, `PI_DEV_LOOPS_DEBUG`→`DEVLOOPS_DEBUG`, `PI_DEV_LOOP_STALE_RUNNER_MAX_AGE_MS`→`DEVLOOPS_STALE_RUNNER_MAX_AGE_MS`, `PI_DEV_LOOP_DETACHED`→`DEVLOOPS_DETACHED`. The Pi-runtime-injected vars dev-loops reads only to *integrate* with the Pi harness (`PI_SESSION`, `PI_INTERACTIVE`, `PI_AGENT_SESSIONS_DIR`, `PI_SUBAGENT_SESSIONS_DIR`, `PI_SUBAGENT_ASYNC_RUNS_DIR`, `PI_SUBAGENT_ASYNC_RESULTS_DIR`) are external Pi-platform contract vars and intentionally unchanged. A `cli-harness-agnostic` guard now asserts the code is harness-agnostic: no dev-loops-owned `PI_*` env var survives, and the Pi-runtime-injected vars may only be read at the harness-adapter boundary (`pi-adapter.mjs`, `conductor-monitor.mjs`) — a `PI_*` read anywhere else in code fails.

- **Remaining `pi-dev-loops` → `dev-loops` identity references aligned** (#906, closes #768). Residual stale-slug strings in a contract doc (and its generated `.claude` mirror) were corrected, guarded by the `docs-identity-contract` test so user-facing identity surfaces stay consistent.

### Fixed

- **`queue run` no longer fabricates `done` for undispatched items** (#913, data-integrity). The queue driver is a deterministic adapter over the board, not the orchestration harness — but its missing-orchestrator path fell back to a per-entry `{ ok: true, pr: null }`, which silently marked every `Next Up` item `done` and moved it to **Done** with `pr: null`/`runId: null` in ~1s without any work happening (a single resolve pass would "complete" an entire backlog untouched). The driver now requires a verifiable terminal signal (an orchestrator-supplied result, e.g. a merged PR) before reflecting an item to Done; with no orchestrator wired (`runEntry`) in the current harness, `dev-loops queue run` is a no-op that leaves every board column unchanged and reports `reason: "no-orchestrator"`. The legit reflect path (real merged PR → Done) is preserved.
- **Queue board `Next Up` membership now resolves from a title-only `.devloops` config** (#904, closes #901). `resolveNextUpOrder` passed the project number as a raw number, which `list-queue-items`' string-only `--project` guard rejected — so a board configured by `queue.boardTitle` alone reported "Board configured but unavailable; nothing to run" and never read `Next Up`. The project ref is now passed as a string.

## 0.3.0

### Added

- **Gate fan-out/fan-in review sub-loop** (epic #867, #895). The draft and pre-approval gates now run as a real fan-out on a **build-once neutral context bundle**: a deterministic context-builder script resolves review angles and builds ONE neutral bundle (full diff + adjacent code), then each independent, read-only `review` agent is seeded with that identical bundle verbatim and scoped to one angle, and a fan-in step consolidates the per-angle verdicts into a disposition ledger. The cost win is work-dedup (build once vs. N× re-derivation; a shared-prefix prompt-cache is an opportunistic bonus) — there is no fork primitive and no Workflow-tool dependency. Verdicts record their execution mode (`--execution-mode fanout_fanin | inline_single_agent`, with `--inline-reason`; #875) so the audit trail shows how the gate was actually run. See [docs/gate-review-sub-loop-contract.md](docs/gate-review-sub-loop-contract.md).
  - **Context-builder handoff + dynamic angles** (#880, #895). A `write-gate-context` step emits the per-gate scope/diff artifact plus a deterministic, neutral `adjacentCode` bundle (each changed file's 1-hop import callers/callees/imports, with size guards + a stripped/truncated/missing manifest) that every reviewer is seeded with verbatim, and angles are resolved dynamically (configurable `mandatory` set plus `gates.dynamicAngles`), bounded by `gates.maxFanoutReviewers` (default 8).
  - **Independent scoped reviewers + fan-in consolidation** (#881, #895). Per-angle `review` agents are independent fresh-context Agents seeded with the neutral bundle (never inheriting the main agent's state); they emit structured findings, and `consolidateFanin` merges them and computes the `fanout_fanin` verdict against `blockCleanOnFindingSeverities` (`must-fix`, `worth-fixing-now`).
  - **Full-diff + adversarial scoped review with scope widening** (#886, #885, #895). The context-builder builds the full PR diff and a generous adjacent-code bundle once, and reviewers use it as their base and widen only per-angle when needed. Reviewers run adversarially against the complete change — this surfaced real defects (arg coercion, head-SHA casing, markdown injection, dead seams) that the prior single-pass review missed.
- **Fan-out findings posted to the PR** (#888, #887). The gate posts a single marker-tagged, idempotent PR comment listing its findings so Copilot and humans see them, and the loop fixes/resolves its own findings as it does Copilot comments. Opt out with `gates.postFindingsComments: false` (default on).
- **Configured board drives queue membership** (#884, #864). A configured GitHub Projects board's `Next Up` column is now the authoritative source of queue membership and ordering (not just status); emptiness reports a precise verdict (`queue_empty` / `board_empty` / `board_unavailable`) instead of a misleading generic message.

### Changed

- **Gate fan-out evidence enforcement is now ON by default** (#882, #879, epic #867 final phase). A clean gate verdict requires the gate to have run via `--execution-mode fanout_fanin` with a findings-log ledger for the head SHA; the pre-merge evidence check fails closed otherwise. Repos can opt out with `gates.requireFanoutEvidence: false`.
- **Board status auto-syncs on dev-loop transitions** (#883, #874). A linked issue's board Status column is synced on loop transitions (e.g. PR opened → `In Progress`, merged → `Done`) via local `gh` auth — best-effort and non-fatal. Repairs the `move-queue-item` lookup that passed numeric (not string) project/item refs.

### Fixed

- **Skill shims import `@dev-loops/core` via its package specifier** (#890). `skills/dev-loop/scripts/log-bash-exit-1.mjs` and `phase-files.mjs` previously reached into core through cross-package relative paths (`../../../packages/core/src/...`), which are broken on disk for npm consumers because the published `dev-loops` package ships `skills/` but not `packages/core/`. They now import via the `@dev-loops/core` `exports` map. A contract test guards against reintroducing relative cross-package imports under `skills/`.
- **Draft-gate deadlock on ready PRs resolved** (#891). Posting a `draft_gate` verdict on a PR that is already ready-for-review (e.g. opened directly as ready) no longer dead-ends. `upsert-checkpoint-verdict` now (a) treats an already-satisfied draft gate as an idempotent no-op instead of a hard error, and (b) when a ready PR still needs clean draft-gate evidence, performs the draft→post→ready transition automatically — preserving the caller's execution mode (`fanout_fanin`), findings, and ledger. This is the fanout-aware analogue of `reconcile-draft-gate` (which only posts inline and so cannot satisfy `requireFanoutEvidence` on the draft gate).
- **PR self-assignment is now mechanically enforced** (#894). The draft-PR wrapper is renamed `scripts/github/create-draft-pr.mjs` → `scripts/github/create-pr.mjs` (`dev-loops pr create-draft` → `dev-loops pr create`, with the old subcommand kept as a deprecated alias). It now defaults `--assignee @me` when no `--assignee` is given (while still honoring an explicit `--assignee <login>`), so every PR opened through the canonical path is ALWAYS a draft and is always assigned — self-assigned by default — closing the silent gap where unassigned PRs (e.g. #889, #892, #893) missed the owner's assignee inbox. A new contract guard (`test/contracts/canonical-pr-creation-contract.test.mjs`) fails if any skill/agent procedure doc instructs opening a PR with raw `gh pr create`.
- **Post-round-cap convergence deadlock resolved** (#896). At the Copilot round cap with clean threads + green CI, a post-cap head that Copilot will not re-review now routes to a clean fallback that permits the `pre_approval_gate` to review the current head, instead of dead-ending at `ready_to_rerequest_review` (the deadlock #848 intended to prevent). Root cause: the coordination-context loader did not pass the resolved config into the loop interpreter, so `maxCopilotRounds` was unseen and `ROUND_CAP_CLEAN_FALLBACK` never resolved; the draft-gate round-reset is now a shared helper so `request-copilot-review` and `detect-pr-gate-coordination-state` agree on the round count. Genuinely-blocked states (failing/unconfirmed CI, unresolved feedback, conflicts, missing draft-gate evidence) still hold.
- **Gate verdict renders consolidated per-angle findings structurally** (#898). A `fanout_fanin` verdict comment renders the per-angle fan-in findings as a readable list (per-angle verdict + findings) via a new `--findings-json`, instead of collapsing the summary to a single run-on line. The gate-evidence parse contract is preserved (a single-line digest still anchors the `Findings summary:` field, and `gateEvidenceNote` is carried), input shape is validated (per-angle or flat-grouped; unrecognized input is rejected rather than silently dropped), and `--findings-summary` remains the inline fallback.

## 0.2.8

### Added

- **Local post-merge board archive** (#869). The dev-loop post-merge step archives `Done`-column board items older than a configurable threshold (`.devloops` `queue.archiveOlderThanDays`, default 7d) using local `gh` auth — best-effort, non-fatal, no CI/cron/PAT. On-demand `dev-loops project archive-done` is unchanged.
- **Gate execution-mode disclosure scaffolding** (#867, partial). Gate verdicts can record `--execution-mode` / `--inline-reason`; opt-in `gates.requireFanoutEvidence` (default off) is available. (Live fan-out/fan-in execution remains follow-up.)

### Fixed

- **`dev-loops project move` repaired** (#865). Item lookup now resolves both issue/PR number and node-id refs against a single paginated board-item list; fixes the `ITEM_NOT_FOUND` (unpaginated `first:10`) and the invalid `ProjectV2.item` GraphQL query.

### Changed

- **Index-based arg parsers migrated to `node:util.parseArgs`** (#857, #870). The remaining `argv[++i]` parsers across `scripts/projects`, `scripts/loop`, `scripts/claude`, and `archive-done-items.mjs` now use `parseArgs`; CLI contracts preserved and boolean flags reject an explicit inline `=value`.

### Documentation

- **Tooling-internals anti-pattern promoted** (#861, #863). The "use the CLI/`--help`/`skills/docs/` instead of reading tooling source" rule is now a canonical entry in `skills/docs/anti-patterns.md`, with a local failure-triage fast path and pointers from the `developer`/`fixer` agents.

## 0.2.7

### Fixed

- **Deterministic, harness-aware dev-loops CLI invocation** (#801, #833). Pi runtime skills/agents now invoke the package-local `node <dev-loops-package-root>/cli/index.mjs`; the generated Claude tree pins `npx dev-loops@<version>` (version injected at generation time) so the plugin and CLI no longer drift.
- **Round-cap Copilot-gate deadlock resolved** (#848). At the round cap with clean threads + green CI, the loop routes to a clean fallback instead of dead-ending at `waiting_for_copilot_review` when a lingering reviewer assignment / post-cap push leaves the head unreviewed. The pre-approval gate still reviews any post-cap head.
- **Draft-gate ordering after external un-draft** (#836). Verified + regression-guarded: a non-draft PR without clean `draft_gate` evidence is routed to `reconcile_draft_gate` and cannot merge; the relayed-authorization deadlock is moot under the single-agent Claude harness.

### Added

- **Projects board reorder + Done-cleanup CLI** (#789). `project reorder move-to-top|move-after|order` (with `--dry-run`, diff-friendly output, cross-column fail-closed) and `project archive-done [--older-than]`.
- **Loop-state-driven board status sync** (#793). Board Status column is derived from the loop state via a pure, config-driven mapping (`queue.statusColumns` / `queue.stateColumnMap`), opt-in, fail-open, reverse-safe.

### Changed

- **Arg parsing migrated to `node:util.parseArgs`** (#808). All hand-rolled `while/shift` parsers (49 scripts/modules + 3 core files) now use `parseArgs` via shared adapters, with CLI contracts preserved. (Index-based parsers tracked in #857.)

## 0.2.6

### Fixed

- **Claude plugin hooks are self-contained** (#843). The bundled PreToolUse/PostToolUse hooks
  imported a bare `@dev-loops/core`, which is unresolvable from the marketplace plugin cache (no
  `node_modules` there), so every hook crashed on load — the two PreToolUse gates were silently
  failing open. The asset generator now emits a vendored, relative-import hook bundle
  (`.claude/hooks/_*.mjs`) from the canonical core modules, drift-guarded by the no-drift check.
- **Retrospective gate is opt-in for consumers** (#841). `extension-defaults.yaml` shipped
  `requireRetrospective`/`requireRetrospectiveGate: true`, forcing the retrospective merge gate on
  every consumer's product PRs against the code default and the contract. Both now default `false`;
  the dev-loops repo opts in via its own `.devloops`.
- **Dev mode is opt-in for consumers** (#846). `extension-defaults.yaml` shipped
  `devModeDefault: true`, pushing every consumer's product phases into the loop's self-improvement
  mode (which edits the loop's own skill/agent prompts). Now defaults `false`; the dev-loops repo
  opts in via `.devloops`.

### Added

- **Merge-blocking PR-title gate** (#842). The gate pipeline now flags `WIP`/`[WIP]`/`DRAFT`/
  `DO NOT MERGE`/`🚧` (case-insensitive) in the PR **title**, blocking the draft→ready transition
  and — for non-draft PRs — entry to the pre-approval gate and final approval. Documented in the
  merge-preconditions and PR-lifecycle contracts.
- **Effective async-start mode is surfaced** (#834). The handoff envelope now reports
  `asyncStartEffective` and `asyncStartRelaxedBy` alongside the unchanged configured
  `asyncStartMode`, so the Claude harness relaxation (`required`→`allowed`) is visible instead of
  reading as a contradiction.

### Changed

- **Deduplicated PR aggregation** (#809). The duplicated `listOpenPrs` helper is extracted into a
  shared `scripts/loop/_loop-pr-aggregation.mjs` and reused by `conductor-monitor.mjs` and
  `run-conductor-cycle.mjs`. No behavior change.

## 0.2.5

### Changed

- **Claude Code: the Copilot PR follow-up loop runs inline** (#838, completing the umbrella
  collapse from #837). The copilot-pr-followup skill's Pi "persistence model" — *subagents do
  bounded work and exit on the wait boundary; the main session re-dispatches* — is now scoped to
  Pi via `<!-- pi-only -->`. Under the Claude harness the single dev-loop agent runs the
  `watch → fix/reply/resolve → re-request → watch` loop **inline**: the helper-owned wait tools
  (`dev-loops loop watch-cycle`, `gh run watch`, `dev-loops gate probe-copilot`) block inline and return, so
  the agent keeps looping until terminal or the watch budget expires — no exit-and-redispatch. The
  outer-loop checkpoint, watch budget, the forbidden-shell-watcher rules, and the gate requirements
  are unchanged and harness-agnostic. Pi behavior is unchanged.

## 0.2.4

### Changed

- **Claude Code: the dev-loop runs as a single agent** (#837). The Pi "umbrella" execution model —
  a strictly read-only main agent that must dispatch an async `dev-loop` subagent, with all
  mutations and state-changing CLI (`gate`/`pr`/`loop`) confined to that subagent — is now scoped
  to Pi only. Under the Claude harness the dev-loop agent performs the steps directly: it reads and
  writes repo files, runs git/PR operations, runs the `dev-loops` CLI, and **posts gate verdicts
  under the operating session's identity** (fixing clean gates that previously stalled, unable to
  record their verdict without separate "coordinator authority"). The `gh pr ready` draft-gate
  guard still applies, and the read-only boundary remains available opt-in via
  `DEVLOOPS_MAIN_AGENT_READONLY=1`. Implemented by scoping the Pi read-only/dispatch contract in
  `main-agent-contract.md` and the dev-loop skill's startup procedure behind `<!-- pi-only -->`
  markers; the asset generator now applies that stripping to bundled contract docs too, so the
  Claude plugin ships the single-agent model while Pi keeps the full contract. Pi behavior is
  unchanged. (Follow-up #838 tracks the copilot-pr-followup/conductor async-execution model.)

## 0.2.3

### Added

- **Opt out of the Copilot review gate via `refinement.maxCopilotRounds: 0`** (#832). For repos
  without a Copilot reviewer configured (or that prefer local-harness-only review), setting
  `maxCopilotRounds: 0` disables the external Copilot review cycle entirely — the loop runs
  `draft_gate → pre_approval_gate` with no Copilot request or wait. The config schema now accepts
  `0` (`nonnegative`; negative still rejected); `evaluatePrGateCoordination` routes `0` through the
  existing `internal_only` path, `shouldGuardCopilotReviewRequest` never forces a request at `0`,
  and the watch-cycle handoff (`copilot-pr-handoff`) skips the request too. Default (`5`) unchanged.
  Documented in the README, extension config docs, and the `copilot-pr-followup` skill.

## 0.2.2

### Fixed

- **Claude Code: dev-loop no longer dead-ends on the async-start contract** (#830). Running
  `/dev-loop` from the installed plugin failed immediately because `dev-loops loop startup`
  enforces an async-start contract — it requires a run-id env marker (`DEVLOOPS_RUN_ID` /
  `PI_SUBAGENT_RUN_ID`) that Pi injects when dispatching an async subagent but Claude Code's
  Agent tool does not. That contract guards against detached, uninspectable background
  processes, a risk that does not exist under Claude's Agent model (each subagent run is
  visible and inspectable). The async requirement remains configurable via
  `workflow.asyncStartMode` (`required` | `allowed`); under the Claude harness it is now
  **relaxed to `allowed` at runtime** via `resolveEffectiveAsyncStartMode`, which consults the
  new `isClaudeHarness` helper (`CLAUDECODE=1`) in `@dev-loops/core/loop/run-context`. An
  explicit `DEVLOOPS_RUN_ID` still resolves as `valid`, and Pi behavior is unchanged (outside
  Claude the configured mode is honored verbatim).
- The async-start CLI contract test is now hermetic — it clears `CLAUDECODE` (and the run-id
  markers) so the rejection path is exercised regardless of the harness the suite runs under.
- The generated `dev-loop` skill prose no longer claims `PI_SUBAGENT_RUN_ID` is *required* — it
  now describes the async run-id marker (`DEVLOOPS_RUN_ID` / `PI_SUBAGENT_RUN_ID` alias) and notes
  the Claude-harness relaxation, so the plugin's docs match the runtime behavior. Subagent
  spawning via the `dev-loop` agent is confirmed correctly wired: it grants the `Agent` tool
  (the current subagent-spawning tool, renamed from `Task` in Claude Code v2.1.63) and the
  strategy skills delegate to the worker agents (`developer`/`quality`/`refiner`/`fixer`/`review`/`docs`).

## 0.2.1

### Added

- **Claude Code marketplace catalog** (#828): ship `.claude-plugin/marketplace.json` at the repo
  root so the repo can be added as a plugin marketplace (`/plugin marketplace add mfittko/dev-loops`,
  or the *Manage Plugins → Marketplaces → Add* UI) and the plugin installed with
  `/plugin install dev-loops@dev-loops`. The catalog's single plugin entry sources the existing
  in-repo plugin at `./.claude`; the plugin version stays authoritative in `plugin.json`. A
  contract test locks the catalog shape, and `.claude-plugin/` is added to the npm `files`
  allowlist. Verified end-to-end with `claude plugin validate` + `marketplace add`/`install`
  (4 skills, 7 agents, 2 hooks).

### Changed

- `plugin.json` now declares an `author` (clears the marketplace-validation warning).
- README "Claude Code plugin" section drops the `(preview)` framing and documents marketplace
  install; the two CLI help lines that said plugin packaging was "in progress" are updated.

## 0.2.0

### Added — Claude Code harness (agent-harness-agnostic dev-loop)

dev-loops is now dual-harness: it runs under both Pi and Claude Code. Pi behavior is unchanged.

- **Harness adapter seam** (#770): a neutral `ExtensionHarnessAdapter` (exec + lifecycle +
  command registration + ui) with Pi and Claude adapters; `@dev-loops/core/harness`.
- **Neutral run-id contract** (#771): `DEVLOOPS_RUN_ID` (with `PI_SUBAGENT_RUN_ID` as a
  backward-compatible alias) via `@dev-loops/core/loop/run-context`; all runner-coordination /
  async-start readers route through it.
- **Generated `.claude` assets** (#772, #816, #817): a deterministic generator emits
  `.claude/agents` + `.claude/skills` from the canonical Pi sources (`@dev-loops/core/claude/
  asset-generation`), with the Pi→Claude tool-name mapping, bundled shared contract docs +
  templates, and Pi-runtime-only prose stripped via `<!-- pi-only -->` markers.
- **Claude hooks + read-only enforcement** (#773): PreToolUse Bash draft-gate guard + Write/Edit
  main-agent read-only guard (`@dev-loops/core/claude/hook-decisions`), opt-in via
  `DEVLOOPS_MAIN_AGENT_READONLY`.
- **CLI Pi-neutrality** (#774): `npx dev-loops --help`/`status` run with no `@earendil-works/pi-*`
  present; Pi-only install strings no longer shown unconditionally.
- **Headless entry** (#775): a `claude -p` headless dev-loop entry (`@dev-loops/core/claude/
  headless-entry`) that mints + propagates the run id, plus an offline read-only CI/Docker smoke
  (`npm run smoke:headless`); the Pi Docker smoke is preserved (dual-harness).
- **Claude Code plugin** (#818, #824): `.claude/.claude-plugin/plugin.json` (plugin root
  `.claude/`) bundling the dev-loop agents, skills, and hooks —
  `claude --plugin-dir .claude` loads 4 skills, 7 agents, 2 hooks.

### Changed

- `@dev-loops/core` bumped to `^0.2.0` (new `claude/*`, `loop/run-context`, and
  `loop/bash-command-classify` exports).

## 0.1.3

### Fixed

- Removed a stale `defaults.yaml` from the `files` allowlist and regenerated the lockfile (#806).

## 0.1.2

### Changed

- Ship the extension-packaged dev-loop defaults only; removed the duplicated
  `.pi/dev-loop/defaults.yaml` (#805).

## 0.1.1

### Changed

- Renamed the Pi peer dependencies to the `@earendil-works/pi-*` scope (#799).

## 0.1.0

### Added

- Initial publishable `dev-loops` v0.1.0 package metadata.
- Primary npm package name is the unscoped `dev-loops` (`@mfittko/dev-loops` kept only as a documented fallback).
- Public npm provenance and access configuration.
- `@dev-loops/core` `^0.1.0` dependency for the extracted scoped runtime package.
- CLI entrypoint `dev-loops` via `./cli/index.mjs`.
- Repository, bugs, and homepage URLs pointing to `mfittko/dev-loops`.

### Removed

- Broken `postinstall` lifecycle script that failed on consumer installs.
