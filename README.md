# dev-loops

Turn a GitHub issue into a merged PR autonomously, up to a human-approval checkpoint.

**Harness-agnostic by design.** The same dev loop runs three ways over one shared core (`packages/core`): as a **Claude Code plugin**, as a **Pi extension**, and as a standalone **CLI**. Routing, gates, and phases are defined once in the core; the plugin and extension are thin integrations over that shared workflow.

## What is a dev loop?

A dev loop takes a GitHub issue through seven lifecycle phases — from intake to merge — with deterministic routing, self-correcting review gates, and autonomous execution until a human approves. The phase is always consultable from the deterministic state model in `packages/core/src/loop/lifecycle-state.mjs`.

| Phase | What happens |
|---|---|
| `issue_intake` | Normalize the issue, confirm scope, detect linked PRs |
| `refinement` | Elaborate the spec, run a bounded audit, harden acceptance criteria |
| `implementation` | Build the accepted scope on a feature branch or via Copilot |
| `draft_gate` | Gate review at the draft→ready boundary before marking the PR ready |
| `feedback_resolution` | Fix, reply to, and resolve review threads on GitHub |
| `pre_approval_gate` | Final gate review: verify evidence, CI, and unresolved threads |
| `merge` | Merge the PR and write the retrospective checkpoint |

The public routing contract is the [Public Dev Loop Contract](./skills/docs/public-dev-loop-contract.md).

## Quick start

`dev-loop` is the single public entrypoint. Drive it in natural language — it resolves the authoritative current state, picks the correct internal strategy, and routes deterministically. You never name internal strategies.

```text
start dev loop on issue 112       # start work on an issue
auto dev loop on issue 112        # run autonomously to the human-approval checkpoint
continue dev loop on PR 88        # continue follow-up on an open PR
```

See the canonical shorthand mapping in the [Public Dev Loop Contract](./skills/docs/public-dev-loop-contract.md).

## Commands

`dev-loop` (natural language) is the catch-all router — reach for the named commands below only when you want a direct, unrouted entrypoint. The syntax differs by harness:

- **Claude Code** exposes each as a plugin slash command: `/loop-start`, `/loop-auto`, …
- **Pi** exposes the core entrypoints as subcommands of one command: `/dev-loops start`, `/dev-loops auto`, …

| Command | Claude Code | Pi | Does |
|---|---|---|---|
| start | `/loop-start <issue>` | `/dev-loops start <issue>` | Start a dev loop on an issue |
| auto | `/loop-auto <issue>` | `/dev-loops auto <issue>` | Run autonomously to the human-approval checkpoint |
| continue | `/loop-continue [issue\|pr]` | `/dev-loops continue [issue\|pr]` | Continue; bare resumes the in-progress board item |
| start-spike | `/loop-start-spike <question>` | `/dev-loops start-spike <question>` | Time-boxed spike (or `--file <path>`) |
| info | `/loop-info <issue\|pr>` | `/dev-loops info <issue\|pr>` | Read-only state summary |
| status | `/loop-status` | `/dev-loops status` | Readiness check (gh auth, git repo, subagent) |
| enqueue | `/loop-enqueue <issue\|pr\|text>` | — | Queue an issue/PR, or capture an idea as a grilled issue |
| grill | `/loop-grill <issue\|plan> [--auto]` | — | Socratic Q&A grill of an issue or plan before the loop |
| queue-status | `/loop-queue-status` | — | Show the queue board grouped by column |

Beyond the per-issue loop entrypoints, the Pi `/dev-loops` command and the `dev-loops` CLI also expose standalone utilities: `help`, `status`, `doctor`, `gates` (`status` is the same readiness check as `loop-status` above). `hide` works only inside Pi — the `dev-loops hide` CLI subcommand is recognized but intentionally exits non-zero (session-local Pi UI behavior). Everything above is also available as a skill/agent — inside Pi, hand work to the `dev-loop` skill rather than calling internal routed skills (`local-implementation`, `copilot-pr-followup`, `final-approval`) directly.

## Install

All examples pin to `<version>` = the `dev-loops` version you installed; keep the CLI, plugin, and extension on the same version so behavior can't drift.

### Claude Code plugin

The repo ships a plugin rooted at `.claude/` (manifest at `.claude/.claude-plugin/plugin.json`) exposing the dev-loop agents, skills, and hooks. Install it from the bundled marketplace catalog:

```text
/plugin marketplace add mfittko/dev-loops    # register the marketplace
/plugin install dev-loops@dev-loops          # install the plugin
```

Or load it directly for a single session without installing:

```bash
claude --plugin-dir .claude
```

Installed from npm, point at the bundled copy: `claude --plugin-dir node_modules/dev-loops/.claude`.

The hooks provide the `gh pr ready` draft-gate guard and an opt-in read-only boundary for the main agent (`DEVLOOPS_MAIN_AGENT_READONLY=1`). Skill references to a consumer repo's own `PLAN.md` / `AGENTS.md` resolve against that repo, by design.

### Pi extension

```bash
pi install npm:dev-loops@<version>       # global, pinned npm package
pi install -l npm:dev-loops@<version>    # project-local (.pi/settings.json)
```

You can also install from git:

```bash
pi install git:github.com/mfittko/dev-loops@<tag-or-sha>       # global
pi install -l git:github.com/mfittko/dev-loops@<tag-or-sha>    # project-local
```

Once a project is trusted, Pi auto-installs missing packages on startup. Install `pi-subagents` the same way when the repo relies on async loop behavior.

### CLI

Run the CLI version-pinned:

```bash
npx dev-loops@<version> --help
```

A global `npm install -g dev-loops` is an optional bare-shell convenience only — it is not version-pinned, updates independently of the plugin/extension, and can silently drift out of sync (#833/#1036). Prefer the pinned `npx` invocation.

## Requirements

Universal:

- Node `>=24`
- `gh` installed and authenticated for GitHub/Copilot workflows

Pi-harness only:

- `pi-subagents` for async workflow behavior
- A Pi host satisfying the peer dependencies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`

## Configuration

Defaults ship in `packages/core/src/config/extension-defaults.yaml`. A repo-local `.pi/dev-loop/defaults.*` layer merges on top of them when present, then consumer repos override everything in a `.devloops` file at the repo root (`.devloops.yaml` / `.yml` / `.json` are also accepted); `.devloops` is authoritative when present. The legacy `.pi/dev-loop/settings.*` and `overrides.*` files still load with a deprecation warning.

```bash
npx dev-loops@<version> gates   # print what reviewers will check
```

Key surfaces:

- **Gate angles** — which review lenses run at the draft and pre-approval gates
- **Personas** — focused per-angle prompts (DRY, KISS, YAGNI, SRP, SoC, and more)
- **Refinement** — fan-out count and mode for parallel review variants; `refinement.maxCopilotRounds` caps Copilot re-review rounds (default `5`). Set `maxCopilotRounds: 0` to disable the Copilot gate entirely — local-harness-only review (`draft_gate → pre_approval_gate`), useful when the repo has no Copilot reviewer configured.
- **Autonomy** — which gates require operator confirmation
- **Workflow defaults** — retrospective enforcement, draft-first posture, dev-mode policy

Full details: [Extension Documentation](./extension/README.md) and `packages/core/src/config/extension-defaults.yaml`.

## Docker

A deterministic container image with all required tooling for dev-loop operation.

```bash
docker build -t dev-loops .
```

| Variable | Purpose | Required |
|---|---|---|
| `GH_TOKEN` | GitHub token for `gh` CLI and API calls | Yes |
| `OPENAI_API_KEY` | LLM provider key (only for `pi` / LLM-backed operations) | No |

Smoke test the image with a minimal read-only info call:

```bash
docker run --rm -e GH_TOKEN="$GH_TOKEN" dev-loops dev-loops loop info --repo mfittko/dev-loops --issue 1
```

Verify the toolchain is reachable:

```bash
docker run --rm dev-loops node --version
docker run --rm dev-loops pi --version
docker run --rm dev-loops dev-loops --version
docker run --rm dev-loops gh --version
```

The Dockerfile pins exact versions for Node.js (base image), the pi CLI, pi extensions, and gh CLI; paired with the committed `package-lock.json`, repeat builds produce functionally identical toolchains.

**Runtime patterns:**

```bash
# Interactive Pi sharing host config (sessions, models, settings write back to ~/.pi)
docker run -it --rm -e GH_TOKEN="$GH_TOKEN" -v "$HOME/.pi:/home/node/.pi" dev-loops pi

# Interactive Pi, clean (ephemeral ~/.pi; provider auth via env)
docker run -it --rm -e GH_TOKEN="$GH_TOKEN" -e OPENAI_API_KEY="$OPENAI_API_KEY" dev-loops pi

# Full dev-loop over a live repo worktree mounted at /workspace
git clone --mirror git@github.com:owner/repo.git /tmp/mirror
git --git-dir=/tmp/mirror worktree add /tmp/run /tmp/mirror/main
docker run -it --rm -e GH_TOKEN="$GH_TOKEN" -v "$HOME/.pi:/home/node/.pi" -v /tmp/run:/workspace dev-loops pi
```

## Development

```bash
npm run verify   # canonical root verification (tests + dev-loop tests)
```

CI splits into a small changed-files gate plus parallel `verify` and conditional `viewer-smoke` jobs. `npm ci` + `npm run verify` run on every change; the Playwright/WebKit viewer smoke runs only when the bounded viewer surface or its smoke-path dependencies change.

### Migrating from an earlier release

Upgrading from before the rename to `dev-loops`? The package name, repo slug, and all `PI_*` environment variables changed (the env vars are a clean break — no aliases). See the [migration guide](./docs/migrating-to-dev-loops.md).

## Further reading

- [Docs Index](./docs/index.md) — active docs and canonical-owner pointers
- [Public Dev Loop Contract](./skills/docs/public-dev-loop-contract.md) — public routing contract
- [Extension Documentation](./extension/README.md) — README-driven extension spec
- [Scripts Documentation](./scripts/README.md) — deterministic script contracts
- [UI Smoke Harness](./docs/ui-smoke-harness.md) — reusable local Playwright/WebKit smoke baseline
- [UI Artifact Contract](./docs/ui-artifact-contract.md) — screenshot/state artifact contract and CI-promotion rules
- [UI Designer Review Loop](./docs/ui-designer-review-loop.md) — designer + vision (`uiReviewMode: vision`) review loop
- [Slides Story Review Loop](./docs/slides-story-review-loop.md) — bounded slides content & storytelling reviewer
