# dev-loops

Turn GitHub issues into merged PRs with zero manual steps between issue and approval.

## What is a dev loop?

A dev loop is an AI-driven development cycle. It takes a GitHub issue through seven lifecycle phases — from intake to merge — with deterministic routing, self-correcting review gates, and autonomous execution until the human approval checkpoint.

**Lifecycle phases:**

| Phase | What happens |
|---|---|
| `issue_intake` | Normalize the issue, confirm scope, detect linked PRs |
| `refinement` | Elaborate spec, run bounded audit, harden acceptance criteria |
| `implementation` | Build the accepted scope on a feature branch or via Copilot |
| `draft_gate` | Gate review at the draft→ready boundary before marking PR ready |
| `feedback_resolution` | Fix, reply to, and resolve review threads on GitHub |
| `pre_approval_gate` | Final gate review: verify evidence, CI, and unresolved threads |
| `merge` | Merge the PR and write the retrospective checkpoint |

Each phase is consultable from the deterministic state model in `packages/core/src/loop/lifecycle-state.mjs`. The public routing contract is [Public Dev Loop Contract](./skills/docs/public-dev-loop-contract.md).

## Quick start

Use **`dev-loop`** as the single public workflow entrypoint:

- `start dev loop on issue 112` — start work on an issue
- `auto dev loop on issue 112` — autonomous execution until human approval
- `continue dev loop on PR 88` — continue follow-up on an open PR

The `dev-loop` entrypoint resolves authoritative state, picks the correct internal strategy, and routes work deterministically. Users never need to choose internal strategy names. See the canonical shorthand example mapping in the [Public Dev Loop Contract](./skills/docs/public-dev-loop-contract.md).

### Direct commands

The same entrypoints are also available as direct named commands — thin wrappers over the public contract, no separate routing:

| Command | Equivalent intent |
| --- | --- |
| `/dev-loops:start <issue>` | start dev loop on issue `<issue>` |
| `/dev-loops:auto <issue>` | auto dev loop on issue `<issue>` (autonomous until human approval) |
| `/dev-loops:continue [issue\|pr]` | continue dev loop on `<issue\|pr>`; bare resumes the single in-progress board item |
| `/dev-loops:start-spike <question>` | start a time-boxed spike from a question (or `--file <path>` for a pre-authored findings file) |
| `/dev-loops:info <issue|pr>` | read-only state summary (`loop info`) |
| `/dev-loops:status` | dev-loop readiness (gh auth, git repo, subagent) |

`/dev-loops:dev-loop` remains the catch-all router. Inside Pi the same set is reachable as `/dev-loops start|auto|continue|start-spike|info|status …`.

## Install from npm

### CLI only

Run the CLI **version-pinned** to the plugin/extension you have installed. The pin is the
single source of truth (`<version>` = your installed `dev-loops` version) and cannot drift:

```bash
npx dev-loops@<version> --help
```

A global `npm install -g dev-loops` is **not** the supported invocation path: the global
binary updates independently of the plugin/extension and silently drifts out of version
(#833/#1036). Install it only as an optional bare shell convenience.

### Claude Code plugin

The repo ships a Claude Code plugin rooted at `.claude/` (manifest at
`.claude/.claude-plugin/plugin.json`) exposing the dev-loop **agents, skills, and hooks**.

Install it from the bundled marketplace catalog (`.claude-plugin/marketplace.json`) by running
these slash commands inside Claude Code:

```text
/plugin marketplace add mfittko/dev-loops    # register the marketplace
/plugin install dev-loops@dev-loops          # install the plugin
```

Or load it directly for a single session without installing:

```bash
claude --plugin-dir .claude                              # load it for a session
claude --plugin-dir .claude plugin details dev-loops     # inspect the discovered components
```

When installed from npm, point at the bundled copy: `claude --plugin-dir node_modules/dev-loops/.claude`.

The plugin is self-contained: it bundles the shared contract docs and templates the skills
reference, and strips Pi-runtime-only prose from the generated assets. The hooks provide the
`gh pr ready` draft-gate guard and the main-agent read-only boundary (the read-only enforcement
is opt-in via `DEVLOOPS_MAIN_AGENT_READONLY=1`). Skill references to a project's own `PLAN.md` /
`AGENTS.md` resolve against the consumer repo, by design.

### Pi extension

To use `/dev-loops` inside Pi:

```bash
pi install npm:dev-loops        # global Pi extension
dev-loops --help
```

You can also install from git:

```bash
pi install git:github.com/mfittko/dev-loops    # global
pi install -l git:github.com/mfittko/dev-loops # project-local
```

The CLI requires Node `>=24` and a GitHub-authenticated `gh` CLI for repository workflows. See [Requirements](#requirements).

## Docker

A deterministic container image with all required tooling for dev-loop operation.

### Build

```bash
docker build -t dev-loops .
```

### Environment variables

| Variable | Purpose | Required for smoke test |
|---|---|---|
| `GH_TOKEN` | GitHub personal access token for `gh` CLI and API calls | Yes |
| `OPENAI_API_KEY` | LLM provider key (needed only when running `pi` / LLM-backed dev-loop operations) | No |

### Smoke test

Verify the image works with a minimal dev-loop info call:

```bash
docker run --rm -e GH_TOKEN="$GH_TOKEN" dev-loops dev-loops loop info --repo mfittko/dev-loops --issue 1
```

### Toolchain verification

Check that all required tools are reachable:

```bash
docker run --rm dev-loops node --version
docker run --rm dev-loops pi --version
docker run --rm dev-loops dev-loops --version
docker run --rm dev-loops gh --version
docker run --rm dev-loops git --version
```

### Repeatable builds

The Dockerfile pins exact versions for Node.js (via base image), pi CLI, pi extensions, and gh CLI. Paired with the committed `package-lock.json`, repeat builds produce functionally identical toolchain versions.

### Runtime patterns

**Interactive Pi with host config (writable):**

```bash
docker run -it --rm \
  -e GH_TOKEN="$GH_TOKEN" \
  -v "$HOME/.pi:/home/node/.pi" \
  dev-loops pi
```

Shares sessions, models, settings. Container writes session logs to host `~/.pi`.

**Interactive Pi clean (no config sharing):**

```bash
docker run -it --rm \
  -e GH_TOKEN="$GH_TOKEN" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  dev-loops pi
```

Ephemeral `~/.pi` inside container. Provider auth via env vars.

**Full dev-loop with live repo worktree:**

```bash
git clone --mirror git@github.com:owner/repo.git /tmp/mirror
git --git-dir=/tmp/mirror worktree add /tmp/run /tmp/mirror/main

docker run -it --rm \
  -e GH_TOKEN="$GH_TOKEN" \
  -v "$HOME/.pi:/home/node/.pi" \
  -v /tmp/run:/workspace \
  dev-loops pi
```

Mounts live repo worktree over baked-in `/workspace`. One isolated Pi session per container.

## Workflow posture

- Use **`dev-loop`** as the single public façade for all routed work
- Prefer the GitHub-first path for active implementation and release work
- Use local implementation only when explicitly requested
- Internal routed logic stays behind the public façade

This repo is shared Pi workflow infrastructure built on generic role agents plus thin workflow entrypoint agents where needed. Thin workflow entrypoint agents are allowed when they only load a skill and defer policy to it.

Phase 8 is the active durable phase; Phase 7 second-repo pilot is deferred. See [Docs Index](./docs/index.md) for the full execution snapshot.

## Configuration

Gate review angles, refinement settings, persona mappings, and workflow defaults are config-driven via `.pi/dev-loop/defaults.yaml`. Consumer repos override values in `.devloops` at repo root (legacy `.pi/dev-loop/settings.yaml` still loads with a deprecation warning). The loader also accepts `.yml` and `.json` extensions and legacy `overrides.*` files as fallback formats. See [Extension Documentation](./extension/README.md) for details.

```bash
npx dev-loops@<version> gates   # see what reviewers will check
```

Key surfaces:
- **Gate angles** — which review lenses run at draft and pre-approval gates
- **Persona prompts** — focused instructions per angle (DRY, KISS, YAGNI, SRP, SoC, and more)
- **Refinement** — fan-out count and mode for parallel review variants; `refinement.maxCopilotRounds` caps Copilot re-review rounds (default `5`), and **`maxCopilotRounds: 0` disables the Copilot review gate entirely** for local-harness-only review (`draft_gate → pre_approval_gate`, no Copilot) — useful when the repo has no Copilot reviewer configured
- **Autonomy** — which gates require operator confirmation
- **Workflow defaults** — retrospective enforcement, draft-first posture, dev-mode policy

Full details: [Extension Documentation](./extension/README.md) and `.pi/dev-loop/defaults.yaml`.

### Migrating from an earlier release

Upgrading an install from before the rename to `dev-loops`? The package name, repo slug,
and all `PI_*` environment variables changed (the env vars are a clean break — no aliases).
See the [migration guide](./docs/migrating-to-dev-loops.md) for the full change list.

## Package surface

The `dev-loops` package ships both a standalone CLI and a Pi extension. Consumer repos should prefer pinned Pi package installs; global npm installs are optional, not part of the Pi runtime contract.

**Pi extension:**

```bash
pi install npm:dev-loops@<version>                         # global, pinned npm package
pi install -l npm:dev-loops@<version>                      # project-local, pinned npm package
pi install git:github.com/mfittko/dev-loops@<tag-or-sha>   # global, pinned git ref
pi install -l git:github.com/mfittko/dev-loops@<tag-or-sha> # project-local, pinned git ref
```

Project-local installs write to `.pi/settings.json`; after the project is trusted, Pi auto-installs missing packages on startup. Install `pi-subagents` the same way when the repo depends on async loop behavior.

Inside Pi, use `dev-loop` as the single public skill/agent entrypoint:

```js
subagent({
  agent: "dev-loop",
  task: "Start dev loop on issue 123 in owner/repo..."
})
```

Do not call internal routed skills such as `local-implementation`, `copilot-pr-followup`, or `final-approval` directly; `dev-loop` selects them from the current GitHub/repo state.

The `/dev-loops` command surface covers the direct dev-loop entrypoints plus readiness and configuration UX:

```bash
/dev-loops start <issue>     # dispatch: start dev loop on issue <issue>
/dev-loops auto <issue>      # dispatch: auto dev loop on issue <issue>
/dev-loops continue [issue|pr] # dispatch: continue dev loop on <issue|pr>; bare = current in-progress board item
/dev-loops info <issue|pr>   # read-only state summary
/dev-loops status
/dev-loops doctor
/dev-loops gates
```

**CLI:**

```bash
npx dev-loops@<version> gates
```

Use `npm install -g dev-loops` only as a bare shell convenience outside Pi; it is not version-pinned, can drift against the plugin/extension, and is not the supported invocation path (prefer `npx dev-loops@<version>`).

The package exposes the `/dev-loops` extension command surface, the `dev-loops` shell CLI, and packaged skills from `package.json` `pi.skills`.

See [Extension Documentation](./extension/README.md) for the full command and package-install contract.

## Requirements

- Node `>=24`
- `gh` installed and authenticated for GitHub/Copilot workflows
- `pi-subagents` for async workflow assumptions
- A Pi host that satisfies peer dependencies on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`

## Development

```bash
npm run verify   # canonical root verification (tests + dev-loop tests)
```

CI splits into a small changed-files gate plus parallel `verify` and conditional `viewer-smoke` jobs. `npm ci` + `npm run verify` run on every change, while the workspace-local Playwright WebKit cache and viewer smoke run only when files in the bounded inspect-run viewer surface or its smoke-path dependencies change.

## Further reading

- [Docs Index](./docs/index.md) — active docs, canonical-owner pointers, and current phase status
- [Extension Documentation](./extension/README.md) — README-driven extension spec
- [Scripts Documentation](./scripts/README.md) — deterministic script contracts
- [UI Smoke Harness](./docs/ui-smoke-harness.md) — reusable local Playwright/WebKit smoke baseline
- [UI Artifact Contract](./docs/ui-artifact-contract.md) — screenshot/state artifact contract and CI-promotion rules
- [UI Designer Review Loop](./docs/ui-designer-review-loop.md) — designer + vision (`uiReviewMode: vision`) review loop contract
- [Slides Story Review Loop](./docs/slides-story-review-loop.md) — bounded slides content & storytelling reviewer (narrative, not pixels)
