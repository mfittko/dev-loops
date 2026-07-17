# Code Context

## Files Retrieved
1. `package.json` (lines 1-95) - root package shape, Node/tooling, tests, bin, Pi extension/skills packaging.
2. `packages/core/package.json` (lines 1-96) - core workspace exports and deps; strongest public module seam.
3. `cli/index.mjs` (lines 1-120) - public `dev-loops` CLI dispatcher and script route table.
4. `lib/dev-loops-core.mjs` (lines 1-145) - command parsing/readiness façade shared by CLI and extension.
5. `extension/index.ts` (lines 1-125) - Pi extension boundary; TypeScript only at harness/UI edge.
6. `packages/core/src/harness/adapter.mjs` (lines 1-57) - minimal harness adapter contract.
7. `packages/core/src/config/config.mjs` (lines 1-180) - existing Zod config schemas; best current runtime typing pattern.
8. `packages/core/src/debt/debt-signal.mjs` (lines 1-46) - smaller Zod schema example for data interchange.
9. `packages/core/src/loop/public-dev-loop-routing-contract.mjs` (lines 1-175) - central routing enums/contract constants.
10. `skills/dev-loop/SKILL.md` (lines 1-120) - canonical workflow/skill architecture and route-pack loading.
11. `test/**/*.mjs` (file list) - Node test layout by contracts, loop, github, projects, extension, package smoke.
12. `scripts/**/*.mjs` (file list) - repo-local operator commands grouped by loop/github/projects/refine/docs/pages.

## Key Code

### Current language/tooling
- Root package is ESM Node, `type: module`, `node >=24`, npm workspaces under `packages/*` (`package.json:4`, `package.json:17-22`).
- Runtime code is mostly `.mjs`; Pi extension code is `.ts` loaded through Pi and tested with `tsx` (`package.json:27`, `package.json:59-65`).
- Test runner is built-in `node --test`; Playwright only for UI slices (`package.json:23-38`).
- Dependencies are tiny: root depends on `@dev-loops/core`; core depends on `yaml` and `zod` (`package.json:74-75`, `packages/core/package.json:91-93`).

### Module seams
- `@dev-loops/core` is the clean library seam. Exports are explicit subpaths: config, github helpers, loop state/routing, queue, harness (`packages/core/package.json:9-64`).
- Root `cli/index.mjs` is a thin process/script dispatcher. It maps categories to repo scripts, not business logic (`cli/index.mjs:48-90`).
- `lib/dev-loops-core.mjs` is a shared façade for parsing `/dev-loops` and CLI top-level intents. It deliberately maps direct verbs to existing skill intents, not new route logic (`lib/dev-loops-core.mjs:12-23`).
- `extension/index.ts` adapts Pi to the shared façade: command handler calls `executeDevLoopsCommand`, then updates widgets or dispatches `/skill:dev-loop ...` (`extension/index.ts:79-105`).
- Harness seam is intentionally minimal: `getCwd`, `getEnv`, `isInteractive`, `isInsidePi`, `getRepoRoot`; comments warn not to turn it into a generic process wrapper (`packages/core/src/harness/adapter.mjs:1-18`).
- Skill docs define runtime flow: one public `dev-loop` façade, startup resolver, handoff envelope, route-specific skill packs only after strategy selection (`skills/dev-loop/SKILL.md:15-18`, `skills/dev-loop/SKILL.md:48-100`).

### Where types would help most
1. **Core exported contracts**: routing result/state shapes around `public-dev-loop-routing` are central and currently represented as frozen JS enums plus normalizers. Type declarations here would prevent drift across scripts/tests (`packages/core/src/loop/public-dev-loop-routing-contract.mjs:16-175`).
2. **CLI/extension result union**: `executeDevLoopsCommand` returns kind-tagged objects consumed by `extension/index.ts` switch. TypeScript already helps in extension with `never`, but source is `.mjs`; colocated JSDoc typedefs or `.d.ts` for result unions would give CLI/tests same contract (`extension/index.ts:88-125`).
3. **Script JSON outputs**: many `scripts/` are operator-facing JSON tools with `--jq` contracts. Shared schemas/types for result envelopes would be useful where downstream tests and docs depend on fields.
4. **Config**: already has best pattern: Zod schemas and `z.infer` typedef (`packages/core/src/config/config.mjs:15-180`, `packages/core/src/config/config.mjs:217` from grep). This is the lazy reusable model: runtime validation + inferred type docs, no broad TS rewrite required.
5. **Harness adapter**: already concise JSDoc typedef. If migrating, this is a low-risk `.d.ts` target, not a reason to add class hierarchy (`packages/core/src/harness/adapter.mjs:10-18`).

### Where design patterns would add bloat
- Do **not** add generic Command/Strategy classes for CLI routing. Route maps are plain objects and readable (`cli/index.mjs:20-90`). More pattern here means more files for same switch.
- Do **not** expand harness adapter into platform abstraction framework. Existing comment explicitly forbids generic process-wrapper creep (`packages/core/src/harness/adapter.mjs:7-8`).
- Do **not** duplicate skill routing in extension/CLI. Current shape forwards entrypoint intents to the canonical skill/router (`lib/dev-loops-core.mjs:12-23`, `extension/index.ts:97-105`).
- Do **not** introduce global domain model classes. Current contracts are data-first: frozen constants, pure evaluators, Zod schemas. This fits Node scripts and tests.
- Avoid broad TypeScript migration as first step. Repo has hundreds of `.mjs` tests/scripts and only extension `.ts`; `.d.ts`/JSDoc/Zod around seams gives most safety with smallest blast radius.

## Architecture

`dev-loops` is a Node ESM monorepo package with one public workflow entrypoint:

- **Public surfaces**
  - `dev-loops` bin -> `cli/index.mjs`.
  - Pi `/dev-loops` command -> `extension/index.ts`.
  - User-facing skill -> `skills/dev-loop/SKILL.md`.

- **Shared command façade**
  - `lib/dev-loops-core.mjs` parses status/doctor/direct entrypoint commands.
  - Direct verbs like `start`, `auto`, `continue`, `info` become canonical skill phrases, not new implementations.

- **Core package**
  - `packages/core/src` holds deterministic, importable logic: routing contracts, state machines, config parsing, queue logic, github helper parsing, harness seam.
  - Core exports are subpath-only. That is the main dependency boundary scripts and tests already use.

- **Repo scripts**
  - `scripts/loop`, `scripts/github`, `scripts/projects`, `scripts/refine`, `scripts/docs`, `scripts/pages` are executable operators/wrappers.
  - Scripts consume `@dev-loops/core` for pure logic and add filesystem/GitHub/CLI side effects.

- **Docs/skills**
  - `skills/docs` contains canonical workflow contracts.
  - `skills/dev-loop/SKILL.md` enforces startup resolver -> handoff envelope -> route-pack loading.

- **Tests**
  - Built-in Node tests mirror architecture: contracts, extension, core package, scripts by domain, docs validators, package smoke, Playwright UI.

## Start Here

Start with `packages/core/package.json` and `packages/core/src/loop/public-dev-loop-routing-contract.mjs`.

Why: core exports define the stable seam; public routing contract is central data model. If deciding migration/design pattern, type these seams first. Do not start in `scripts/`; scripts are adapters around core.

## Supervisor coordination

No supervisor decision needed. Read-only scouting completed. Wrote progress and output artifacts only.

## Acceptance Evidence

- Changed files: artifact writes only:
  - `/Users/mfittko/github/dev-loops/.pi-subagents/artifacts/progress/c5c23ddb/progress.md`
  - `/Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/c5c23ddb/context.md`
- Tests added: none; read-only architecture mapping.
- Commands run: `ls`, `find`, `grep`, `read`, `nl -ba ... | sed`, `git status --short`.
- Validation output: `git status --short` shows no staged files; only pre-existing/untracked artifact area and scratchpads are untracked.
- Residual risks: Scout did not inspect every script body; mapped entrypoints/seams/selective representative files per task.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Completed read-only architecture map and did not modify repo source; only requested artifact/progress files were written."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Findings cite exact files and line ranges, commands run, validation output, and residual risks."
    }
  ],
  "changedFiles": [
    "/Users/mfittko/github/dev-loops/.pi-subagents/artifacts/progress/c5c23ddb/progress.md",
    "/Users/mfittko/github/dev-loops/.pi-subagents/artifacts/outputs/c5c23ddb/context.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "ls .",
      "result": "passed",
      "summary": "Listed repo root shape."
    },
    {
      "command": "read package.json; find packages/core/src scripts test skills/docs; grep @dev-loops/core imports",
      "result": "passed",
      "summary": "Mapped package/tooling, core exports, scripts, tests, docs, and core consumers."
    },
    {
      "command": "nl -ba selected files | sed -n ranges",
      "result": "passed",
      "summary": "Captured exact line ranges for cited entrypoints and contracts."
    },
    {
      "command": "git status --short",
      "result": "passed",
      "summary": "No staged files; untracked artifact directory/scratchpads present."
    }
  ],
  "validationOutput": [
    "git status --short output: ?? .pi-subagents/; ?? scratchpad_envelope.json; ?? scratchpad_resolver.json"
  ],
  "residualRisks": [
    "Selective scout, not full-file audit of every script. Enough for migration/design-pattern decision."
  ],
  "noStagedFiles": true,
  "diffSummary": "No repo source diff; wrote requested scout artifacts only.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "Read-only/no-mutation scope honored except required artifact/progress writes."
}
```
