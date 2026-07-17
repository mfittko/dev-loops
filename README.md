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
| review-ui | `/loop-review-ui <pr>` | — | Review a PR in a running-app UI loop |

Beyond the per-issue loop entrypoints, the Pi `/dev-loops` command and the `dev-loops` CLI also expose standalone utilities: `help`, `status`, `doctor`, `gates` (`status` is the same readiness check as `loop-status` above). `hide` works only inside Pi — the `dev-loops hide` CLI subcommand is recognized but intentionally exits non-zero (session-local Pi UI behavior). Everything above is also available as a skill/agent — inside Pi, hand work to the `dev-loop` skill rather than calling internal routed skills (`local-implementation`, `copilot-pr-followup`, `final-approval`) directly.

### `/loop-review-ui`

`/loop-review-ui <pr>` reviews a PR by **proving the change in the running app** from an isolated worktree, rather than reading the diff alone. It runs the loop `resolve → provision/boot → auth+drive → diagnose → report → teardown`: it provisions a worktree for the PR head and boots the app, authenticates and drives the changed UI flows (capturing a screenshot + state + snapshot per step), maps captured failures back to the diff, posts a head-pinned **pending** PR review plus a self-contained screenshot artifact, then tears down — always emitting a side-effect ledger.

**When to use it vs. the standard `review` angle:** reach for `/loop-review-ui` when a change is only really provable by exercising it in a browser — a rendered flow, a create/edit/upload interaction, or a swallowed server error the UI hides behind a success state. It is the running-app sibling of, not a replacement for, the diff-reading `review` angle or the Copilot gate; those still run for logic, structure, and correctness. It requires a per-project run/auth recipe in `.devloops` and runs end-to-end on any harness; only the report-artifact hosting is harness-aware. On Claude Code the self-contained artifact gets a zero-setup hosted link (Claude Artifacts); off-Claude the same artifact is still produced but emitted unhosted with a stated reason (a hosted GitHub-native link is a tracked follow-up), never a hard stop. See the [UI-Review Run/Auth Recipe Contract](./skills/docs/ui-review-recipe-contract.md) to wire a consuming repo.

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

**Consumer entry contract.** The plugin ships prompts, skills, agents, and hooks only — the runtime that actually executes commands is always the npm `dev-loops` CLI (`npx dev-loops@<version>`), never a raw `node scripts/*.mjs` invocation against the marketplace checkout. A `/plugin marketplace add` or `/plugin install` checkout has no install hook and therefore no `node_modules`; running local scripts directly from it is unsupported and `dev-loops doctor` / the CLI preflight will name the condition and point back here. The single-source CLI subcommand reference is tracked in [issue #1376](https://github.com/mfittko/dev-loops/issues/1376).

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

Defaults ship in `packages/core/src/config/extension-defaults.yaml`. A repo-local `.pi/dev-loop/defaults.*` layer merges on top of them when present, then consumer repos override everything in a `.devloops` file at the repo root (`.devloops.yaml` / `.yml` / `.json` are also accepted); `.devloops` is authoritative when present. The legacy `.pi/dev-loop/settings.*` and `overrides.*` files load only as a fallback when no `.devloops` is present; when `.devloops` exists they are ignored (a deprecation warning still fires if they are present).

```bash
npx dev-loops@<version> gates   # print what reviewers will check
```

Key surfaces:

- **Gate angles** — which review lenses run at the draft and pre-approval gates
- **Personas** — focused per-angle prompts (DRY, KISS, YAGNI, SRP, SoC, and more)
- **Gates** — per-gate `requireCi` CI-precondition toggle (`gates.draft.requireCi`, `gates.preApproval.requireCi`; default `true`). Set a gate's `requireCi: false` to opt that gate out of the CI precondition — e.g. a repo with no CI can run the loop end-to-end instead of blocking at the gate.
- **Refinement** — fan-out count and mode for parallel review variants; `refinement.maxCopilotRounds` caps Copilot re-review rounds (default `5`). Set `maxCopilotRounds: 0` to disable the Copilot gate entirely — local-harness-only review (`draft_gate → pre_approval_gate`), useful when the repo has no Copilot reviewer configured.
- **UI review** — the `uiReview` surface configures the `/loop-review-ui` route (per-project run/boot command, login recipe, log/exception patterns)
- **Autonomy** — which gates require operator confirmation
- **Workflow defaults** — retrospective enforcement, draft-first posture, dev-mode policy

Full details: the shipped defaults in `packages/core/src/config/extension-defaults.yaml` and the loader in `packages/core/src/config/config.mjs`.

## Stability

From **1.0**, `dev-loops` follows [semantic versioning](https://semver.org/) for its public surface — breaking changes to it bump the major version:

- **The `.devloops` configuration surface** — gate angles, personas, `gates.*` (including each gate's `requireCi` toggle and `gates.preApproval.requireCi`), `refinement.*`, `uiReview.*`, `autonomy.*`, and `workflow.*`. The authoritative validator is the config loader in `packages/core/src/config/config.mjs`; `schemas/dev-loop-config.schema.json` is generated from it (`node scripts/generate-config-schema.mjs`) and covers the full file-level surface — only cross-field refinements stay zod-only.
- **The public `dev-loop` command and skill surface** — the natural-language `dev-loop` router and the named `/loop-*` entrypoints.
- **The routing contract** — the [Public Dev Loop Contract](./skills/docs/public-dev-loop-contract.md).

Internal strategy names, script internals, and undocumented helpers are not part of the stable surface and may change in a minor release. New config keys and gate angles are additive (minor); removing or repurposing an existing one is a breaking change (major).

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

CI splits into a small changed-files gate plus a parallel `verify-suite` matrix (one leg per `test:*` suite) gated by a fail-closed `verify` job, and a conditional `viewer-smoke` job. On every change, `npm ci` runs and the verify suites run as parallel matrix legs; the Playwright/WebKit viewer smoke runs only when the bounded viewer surface or its smoke-path dependencies change.

### Migrating from an earlier release

Upgrading from before the rename to `dev-loops`? The package name, repo slug, and all `PI_*` environment variables changed (the env vars are a clean break — no aliases). See the [migration guide](./docs/migrating-to-dev-loops.md).

## Further reading

- [Docs Index](./docs/index.md) — active docs and canonical-owner pointers
- [README Audit Rubric](./docs/readme-audit-rubric.md) — semantic properties this README is audited against (on-demand LLM judge)
- [Public Dev Loop Contract](./skills/docs/public-dev-loop-contract.md) — public routing contract
- [Extension Documentation](./extension/README.md) — README-driven extension spec
- [Scripts Documentation](./scripts/README.md) — deterministic script contracts
- [UI Smoke Harness](./docs/ui-smoke-harness.md) — reusable local Playwright/WebKit smoke baseline
- [UI Artifact Contract](./docs/ui-artifact-contract.md) — screenshot/state artifact contract and CI-promotion rules
- [UI Designer Review Loop](./docs/ui-designer-review-loop.md) — designer + vision (`uiReviewMode: vision`) review loop
- [UI-Review Run/Auth Recipe Contract](./skills/docs/ui-review-recipe-contract.md) — per-project run/login/flow recipe for `/loop-review-ui`
- [Slides Story Review Loop](./docs/slides-story-review-loop.md) — bounded slides content & storytelling reviewer
