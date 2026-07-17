# Extension scaffold

`dev-loops` ships a lightweight package extension for readiness UX plus one bounded local UI lifecycle seam.

Installing the package exposes two thin wrappers over one shared deterministic core:
- the Pi extension command family rooted at `/dev-loops`
- the shell CLI entrypoint `dev-loops`
- a bounded post-merge helper that queues one `pi update git:github.com/mfittko/dev-loops` after a successful in-session `gh pr merge ...` or `git merge ...` inside this repo and flushes it on `agent_end`

Installing the package with `pi install git:github.com/mfittko/dev-loops` exposes the packaged skills through `package.json` `pi.skills`, and the extension syncs packaged agent files (`agents/*.agent.md`) into `~/.agents/` on `session_start`.

**Version pinning (no global-install skew).** The extension resolves both the CLI and `@dev-loops/core` from the installed, pinned package (module imports, not a global `dev-loops` binary), and updates itself via the pinned `pi update git:github.com/mfittko/dev-loops` seam above. It never depends on a separately-updated global install, so it stays in lockstep with the installed version by construction (#1036).

## Command surface

- `/dev-loops`
  - defaults to help output for the available subcommands
- `/dev-loops status`
  - concise readiness summary plus lightweight next steps
- `/dev-loops doctor`
  - full diagnostic report with explicit pass/fail detail
- `/dev-loops hide`
  - removes the readiness widget cleanly
- `/dev-loops inspect open [--repo <owner/name>]`
  - start or reuse the managed local inspect-run viewer and best-effort open it in the browser
- `/dev-loops inspect resume [--repo <owner/name>]`
  - reattach only to a confirmed live managed inspect-run viewer; fails closed when nothing live is managed
- `/dev-loops inspect status [--repo <owner/name>]`
  - report one bounded local lifecycle state plus the current URL when known
- `/dev-loops inspect stop [--repo <owner/name>]`
  - stop only the recorded managed inspect-run viewer process
- `/dev-loops inspect restart [--repo <owner/name>]`
  - explicitly restart the recorded managed inspect-run viewer; never kill an unknown listener
- `dev-loops`
  - defaults to help output for the available subcommands
- `dev-loops help`
  - prints shell help for the shared command family
- `dev-loops status`
  - prints the concise readiness summary in shell-friendly output
- `dev-loops doctor`
  - prints the full diagnostic report in shell-friendly output
- `dev-loops gates`
  - prints active review angles with their prompts from config
- `/dev-loops gates`
  - same as above, but inside the Pi extension
- `dev-loops hide`
  - is intentionally unsupported and exits non-zero with a shell-friendly stderr message because `hide` is session-local Pi UI behavior

## Inspect local UI lifecycle ownership

This slice is intentionally narrow.

Extension-owned behavior:
- operator-facing lifecycle UX under `/dev-loops inspect ...`
- repo-local managed-instance record at `.pi/ui-servers/inspect-run-viewer.json`
- safe URL discovery, liveness checks, resume/reattach, stop, and explicit restart handling
- best-effort browser open
- fail-closed handling for stale ownership and unknown listeners

Viewer-script-owned behavior:
- HTTP server implementation
- viewer HTML/JS rendering
- inbox and query-state behavior
- snapshot loading through the existing adapter
- read-only route behavior and localhost safety rules

Lifecycle states reported by the extension-managed seam are intentionally bounded to:
- `running`
- `stopped`
- `stale_record`
- `conflict_unmanaged_listener`

Guard rails for this seam:
- loopback-first local-only posture
- no remote/public hosting
- no generic local app platform
- no background watcher/supervisor behavior
- no inspect-run viewer redesign

## Current readiness checks

The extension currently reports on:
- `gh` installed
- `gh` authenticated
- `subagent` command available
- inside a git repository

Readiness and help messaging should lead with `dev-loop` as the single public workflow entrypoint. Internal compatibility seams may still exist for runtime/routing purposes, but the readiness surface should not present them as separate user-facing checks or workflow choices.

The messaging distinguishes between local loop readiness and remote GitHub/Copilot readiness. Missing `gh` or `gh auth` blocks remote-loop readiness, but does not imply that local phase-based work is completely unavailable.

## Package install contract for this phase

- `pi install git:github.com/mfittko/dev-loops` is the distribution mechanism for the extension, skills, scripts, packaged agents, and required installed runtime contract docs
- `pi install -l git:github.com/mfittko/dev-loops` is the project-local replacement for the old `install repo` flow
- `pi update git:github.com/mfittko/dev-loops` refreshes an installed package
- source-tree canonical contract docs live under `skills/docs/`; installer/package output must ship this shared docs bundle with the installed skills subtree: [Public Dev Loop Contract](../skills/docs/public-dev-loop-contract.md) and [Retrospective Checkpoint Contract](../skills/docs/retrospective-checkpoint-contract.md)
- installed skill/runtime guidance must read those bundled shared docs (from installed `skills/<skill>/`, resolve via `../docs/`) instead of assuming a source checkout is present; a missing bundled contract doc is a packaging/installer bug
- packaged agents are refreshed into `~/.agents/` on each `session_start`
- `/dev-loops install ...` and `/dev-loops update ...` are removed; use `pi install` / `pi update` directly instead

## Configuration

The dev-loop workflow is driven by the shipped defaults in `packages/core/src/config/extension-defaults.yaml`, an optional repo-local `.pi/dev-loop/defaults.*` layer that merges on top of them, and an optional consumer settings file at `.devloops` at repo root (the loader also accepts `.devloops.yaml`, `.devloops.yml`, and `.devloops.json`; legacy `.pi/dev-loop/settings.*` and `.pi/dev-loop/overrides.*` load only as a fallback when no `.devloops` is present, and are ignored when `.devloops` exists — a deprecation warning still fires).

### How consumers customize config

Create `.devloops` at your project root. It merges on top of the shipped defaults. Accepted formats: `.devloops` (bare, YAML-format), `.devloops.yaml`, `.devloops.yml`, or `.devloops.json`. Legacy `.pi/dev-loop/settings.*` and `overrides.*` still load as fallbacks with a deprecation warning. You can override any section, including workflow policy defaults:

```yaml
# Example: add a custom review angle with a dedicated persona agent
gates:
  preApproval:
    angles:
      - dry
      - kiss
      - yagni
      - security    # your custom angle

personas:
  security:
    persona: security-reviewer
    prompt: >-
      Audit for auth bypasses, secret leaks, insecure defaults,
      unsafe command execution, and data exposure risks.
    defaultModel: null

  # Override an existing angle's prompt
  dry:
    persona: review
    prompt: >-
      Flag duplication. In this repo, also check for duplicated
      contract language across docs/ and skills/.
    defaultModel: null

# Override gate requirements
refinement:
  fanOut: 5            # run 5 parallel review variants instead of 3
  maxCopilotRounds: 0  # 0 disables the Copilot review gate entirely (local-harness-only
                       # review: draft_gate → pre_approval_gate, no Copilot). Default: 5.

autonomy:
  stopAt:
    - draft-pr
    - merge        # stop for confirmation at both gates

workflow:
  requireRetrospective: true
  requireDraftFirst: true
  devModeDefault: true
  baseBranch: spike/shakapacker-to-vite  # operate against a non-main integration branch
```

### Model tiers (`models.tiers` / `models.roleTiers`)

Subagents run on a harness-neutral **tier** so a single policy expresses "high on both harnesses" even though the concrete model ids differ. A tier alias maps to a per-harness concrete model (or `null` = inherit / no-op on that harness); `models.roleTiers` maps each role/angle to an alias (or `inherit`).

**Default policy (zero config):** routine subagents (`developer`, `docs`, `fixer`, `quality`) → `low`; planning (`refiner`) and critical review (`review`, including gate fan-out angles via the review tier forced by `kind: "angle"`) → `high`; the conductor (`dev-loop`) → `inherit`. Built-in tiers are `low: { claude: sonnet, pi: null }`, `high: { claude: opus, pi: null }`.

**Per-harness resolution:** `resolveRoleModel(config, { role, harness })` from `@dev-loops/core/config` returns a concrete model id or `null`. Precedence: `models.roles[role]` (concrete, highest) > tier from `models.roleTiers[role]` (or the built-in role tier) mapped through `models.tiers[alias][harness]` > `null`. The committed `.claude/agents/*.md` tree bakes the built-in (zero-config) tier policy into each agent's `model:` frontmatter — asset generation does not read repo `.devloops` config, so per-repo config never regenerates that frontmatter. Per-repo/per-dispatch tuning happens at dispatch time: on Pi via `resolveRoleModel` (passed only when non-null), on Claude via the Task `model` param.

**Zero-config no-op on Pi:** because built-in tiers ship `pi: null`, every role resolves to `null` on Pi — no model override is passed, a genuine no-op — until an operator sets concrete Pi ids. The same config drives both harnesses (cross-harness contract #1086).

```yaml
models:
  tiers:
    low:  { claude: sonnet, pi: claude-3-5-haiku }   # set pi ids to opt Pi in
    high: { claude: opus,   pi: claude-3-5-sonnet }
  roleTiers:
    quality: high            # promote a routine role
    developer: inherit       # opt a role out entirely
  roles:
    correctness: gpt-5       # concrete per-angle override (beats any tier)
```

Angles are dispatched with `resolveRoleModel(config, { role: angle, harness, kind: "angle" })`. Their precedence is: `models.roles[angle]` (concrete) > explicit `models.roleTiers[angle]` > the **`review` tier** (high). A gate review runs at review quality regardless of the angle's persona, so an angle whose **name** collides with a built-in routine role no longer takes that role's tier — e.g. the `docs` review angle resolves via the `review` tier (`high`), not the `docs`→low writer role (only its persona/agent still comes from the registry). Genuinely distinct angles (`correctness`, `renderer-security`, `acceptance-criteria`) resolve `high` too. Only a **bare routine role** dispatch (no `kind`, e.g. the `docs`/`developer` subagents) still resolves `low` via `roleTiers`. Retarget a specific angle by setting `models.roleTiers[angle]` explicitly. An unknown tier alias in `models.roleTiers` is rejected by the schema with a clear error.

### Available review angles

The shipped defaults activate these angles. Additional angles are available as opt-in — add them to your `gates.draft.angles` or `gates.preApproval.angles` and they'll use the prompts defined in the personas registry. Opt-in prompts are generic and can be overridden in consumer repos through `personas.<angle>.prompt` without depending on this repository's audit examples.

| Default (active) | Opt-in (add to gates) |
|---|---|
| `dry` — duplication | `ocp` — Open/Closed (extension over modification) |
| `kiss` — over-engineering | `lsp` — Liskov Substitution (subtype contracts) |
| `yagni` — speculative features | `isp` — Interface Segregation (fat interfaces) |
| `srp` — Single Responsibility | `dip` — Dependency Inversion (abstractions) |
| `soc` — Separation of Concerns | `docs` — documentation links, command references, stale docs |
| `deep` — structural quality / deslop audit | |
| `scope` — scope compliance (draft gate) | `link-check` — Markdown links, anchors, doc paths |
| `coverage` — test coverage (draft gate) | `config-drift` — config/schema/docs/runtime disagreement |
| `correctness` — acceptance criteria (draft gate) | `gate-evidence` — missing/stale gate-review PR evidence |
| `ci-guard` — CI/workflow reproducibility (draft gate) | `no-op` — ineffective tool or command usage |
| `contract-surface` — schema/runtime/docs plus CLI help/stdout/stderr drift (draft gate) | `input-validation` — CLI/API args, repo slugs, IDs, sentinels |
| | `packaging-runtime` — installers, bundles, copied assets, runtime imports |
| | `state-concurrency` — state files, locks, polling/process cleanup |
| | `renderer-security` — HTML/attribute/URL escaping and user content |
| | `determinism` — ordering, tie-breakers, strict stubs, env/time independence |

### Workflow defaults

The optional `workflow` family carries repo-level workflow posture without hardcoding it into prose-only guidance. Shipped defaults stay permissive:

```yaml
workflow:
  requireRetrospective: false
  requireDraftFirst: false
  devModeDefault: false
  # baseBranch: unset by default — the loop auto-detects the repo's default
  # branch (origin/HEAD, else main/master).
```

- `requireRetrospective` — when enabled by repo settings, the next qualifying GitHub-first async start/resume must honor the retrospective checkpoint gate
- `requireRetrospectiveGate` — **removed (issue #1077)**. The retrospective is now advisory: it always runs and returns findings to the conductor via the envelope's `retrospectiveFindings` field and an advisory PR comment, never blocking merge or any transition. There is no longer a merge-gate config key for the retrospective.
- `requireDraftFirst` — marks draft-first PR creation as required workflow policy for repos that opt in
- `devModeDefault` — declares that local implementation should default to formal dev mode; this is config-only for now and establishes source-of-truth config plus docs for future runtime consumers
- `baseBranch` — repo-level base/integration branch override (bare name, e.g. `main` or `spike/shakapacker-to-vite`). When set, a full dev-loop (worktree creation, PR targeting, issue-less scope measurement) operates against it instead of the auto-detected default branch — the knob a phased migration (or any work that must stack on one long-lived integration branch and never touch `main`) needs. Unset (the default) keeps auto-detecting `origin/HEAD`, else `main`/`master`. Resolved by `resolveBaseBranch(config, { cwd })` from `@dev-loops/core/config`; `scripts/loop/ensure-worktree.mjs` and `scripts/github/create-pr.mjs` stay config-agnostic — the resolved base is injected as an explicit `--base` by the resolver's `nextAction` hint and the `local-implementation` SKILL's PR-create step.

### Config precedence

1. Built-in defaults (`packages/core/src/config/config.mjs` `BUILT_IN_DEFAULTS`)
2. Shipped defaults (`packages/core/src/config/extension-defaults.yaml`)
3. Repo-local override layer (`.pi/dev-loop/defaults.*` — merges on top of the shipped defaults when present)
4. Consumer settings (`.devloops` at repo root — preferred and authoritative when present; `.devloops.yaml`/`.devloops.yml`/`.devloops.json` also load; legacy `.pi/dev-loop/settings.*` and `.pi/dev-loop/overrides.*` load only as a fallback when no `.devloops` is present; when `.devloops` exists they are ignored, with a deprecation warning)

### Adding custom review angles

1. Add the angle name to `gates.draft.angles` or `gates.preApproval.angles`
2. Add a `personas.<angle>` entry with a `persona` agent name and a `prompt` instruction
3. Create the corresponding `Agent file` (`agents/<persona>.agent.md`) if using a new persona
4. Optionally set a per-angle model override via `models.roles.<angle>`

### Config format

YAML is preferred (`.yaml` or `.yml`). JSON (`.json`) is supported as a fallback for backward compatibility. When both exist, YAML takes priority.

Config is validated at runtime by Zod schemas (`packages/core/src/config/config.mjs`).

## Runtime / build / test contract

Current Phase 3+ contract:
- Node runtime floor: `>=24` (from `package.json`)
- Pi host expectations are documented from current peer dependencies rather than a tested pinned Pi version range
- the extension is source-loaded from `./extension/index.ts` through `package.json` `pi.extensions`
- the package exposes `skills` through `package.json` `pi.skills` for install-based global skill loading
- the shell CLI is exposed through `package.json` `bin.dev-loops`
- the extension syncs packaged agent files (`agents/*.agent.md`) into `~/.agents/` on `session_start` so user-level agents are available outside this repo
- package install/update happens through `pi install` / `pi update`
- this phase does not yet claim a specific supported `gh` version; it only checks `gh` presence and authentication state
- this phase does not require a separate compiled build or `dist/` pipeline

Root verification and test commands are intentionally explicit:
- `npm run verify` is the canonical root verification path; it runs every suite in parallel via `run-p` as a single aggregated command, and any suite failing fails verify
- `npm test` runs the current root test suite (`test:assets`, `test:extension`, `test:scripts`, `test:core`, and `test:docs`)
- `npm run test:extension`
- `npm run test:extension` currently expands to one `node --import tsx --test ...` invocation in `package.json`; prefer the script entrypoint over copying the file list into downstream docs or runbooks
- `npm run test:scripts`
- `npm run test:assets`
- `npm run test:dev-loop`
- `npm run test:playwright:viewer` remains an explicit viewer/browser smoke, not part of the default root verify path

## Design rule

Both wrappers should stay thin. Shared workflow mechanics should live in deterministic `packages/core/` modules and `scripts/`, not in extension-only or CLI-only command logic. Runtime command support that bridges both surfaces belongs in `lib/dev-loops-core.mjs`. See [Library vs Packages Core Boundary](../docs/lib-vs-packages-core-boundary.md) for the full ownership rule.
