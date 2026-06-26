# Changelog

All notable changes to this project will be documented in this file.

## 0.3.0

### Added

- **Gate fan-out/fan-in review sub-loop** (epic #867). The draft and pre-approval gates now run as a real fan-out: a context-builder resolves review angles, forks one scoped, read-only `review` agent per angle, and a fan-in step consolidates the per-angle verdicts into a disposition ledger. Verdicts record their execution mode (`--execution-mode fanout_fanin | inline_single_agent`, with `--inline-reason`; #875) so the audit trail shows how the gate was actually run. See [docs/gate-review-sub-loop-contract.md](docs/gate-review-sub-loop-contract.md).
  - **Context-builder handoff + dynamic angles** (#880). A `write-gate-context` step emits the per-gate scope/diff artifact the forked reviewers consume, and angles are resolved dynamically (configurable `mandatory` set plus `gates.dynamicAngles`), bounded by `gates.maxFanoutReviewers` (default 8).
  - **Forked scoped reviewers + fan-in consolidation** (#881). Per-angle `review` agents emit structured findings; `consolidateFanin` merges them and computes the `fanout_fanin` verdict against `blockCleanOnFindingSeverities` (`must-fix`, `worth-fixing-now`).
  - **Full-diff + adversarial scoped review with scope widening** (#886, #885). The context-builder loads the full PR diff and adjacent code, and reviewers can request scope widening. Reviewers run adversarially against the complete change — this surfaced real defects (arg coercion, head-SHA casing, markdown injection, dead seams) that the prior single-pass review missed.
- **Fan-out findings posted to the PR** (#888, #887). The gate posts a single marker-tagged, idempotent PR comment listing its findings so Copilot and humans see them, and the loop fixes/resolves its own findings as it does Copilot comments. Opt out with `gates.postFindingsComments: false` (default on).
- **Configured board drives queue membership** (#884, #864). A configured GitHub Projects board's `Next Up` column is now the authoritative source of queue membership and ordering (not just status); emptiness reports a precise verdict (`queue_empty` / `board_empty` / `board_unavailable`) instead of a misleading generic message.

### Changed

- **Gate fan-out evidence enforcement is now ON by default** (#882, #879, epic #867 final phase). A clean gate verdict requires the gate to have run via `--execution-mode fanout_fanin` with a findings-log ledger for the head SHA; the pre-merge evidence check fails closed otherwise. Repos can opt out with `gates.requireFanoutEvidence: false`.
- **Board status auto-syncs on dev-loop transitions** (#883, #874). A linked issue's board Status column is synced on loop transitions (e.g. PR opened → `In Progress`, merged → `Done`) via local `gh` auth — best-effort and non-fatal. Repairs the `move-queue-item` lookup that passed numeric (not string) project/item refs.

### Fixed

- **PR self-assignment is now mechanically enforced** (#894). The draft-PR wrapper is renamed `scripts/github/create-draft-pr.mjs` → `scripts/github/create-pr.mjs` (`dev-loops pr create-draft` → `dev-loops pr create`, with the old subcommand kept as a deprecated alias). It now defaults `--assignee @me` when no `--assignee` is given (while still honoring an explicit `--assignee <login>`), so every PR opened through the canonical path is ALWAYS a draft and is always assigned — self-assigned by default — closing the silent gap where unassigned PRs (e.g. #889, #892, #893) missed the owner's assignee inbox. A new contract guard (`test/contracts/canonical-pr-creation-contract.test.mjs`) fails if any skill/agent procedure doc instructs opening a PR with raw `gh pr create`.

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
