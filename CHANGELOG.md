# Changelog

All notable changes to this project will be documented in this file.

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
