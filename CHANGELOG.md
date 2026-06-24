# Changelog

All notable changes to this project will be documented in this file.

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
