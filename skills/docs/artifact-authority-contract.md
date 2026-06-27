# Artifact authority contract

This document is the canonical authority for the artifact-selection model: whether a work item originates from a GitHub issue (tracker-first) or from a persisted markdown plan file (local-planning).

This canonical owner lives in the shipped `skills/docs/` surface because installed skill/runtime consumers reliably own the skills subtree. In installed layouts, read the same contract via [Artifact Authority Contract](../docs/artifact-authority-contract.md) from the installed skill directory.

Other repo docs may summarize or link this contract, but they should not redefine it.

## Two-tier model

dev-loops supports two mutually exclusive artifact authority modes. Every work item originates from exactly one authoritative artifact: a GitHub issue or a persisted markdown plan file. Work originates from a PR or a direct local change only when explicitly requested.

The shipped extension default selects local-planning; see [Shipped default posture](#shipped-default-posture) below. The mode names that follow describe the two tiers; "default" in their headings refers to the github-first code-level fallback in `BUILT_IN_DEFAULTS`, which the shipped extension layer overrides to local-first.

### Tracker-first

**GitHub issues are the authoritative artifact store.** Work originates from a GitHub issue. A linked PR is the execution artifact. GitHub is the canonical source of truth for issue identity, acceptance criteria, scope, and lifecycle state.

Artifacts:
- **Planning artifact:** GitHub issue (title, body, labels, assignees, acceptance criteria)
- **Execution artifact:** GitHub PR (linked to issue; created during implementation)
- **No local duplicate:** Do not create `docs/phases/phase-<n>.md` for the same session when a GitHub issue is the canonical spec

Key contract:
- GitHub issue state is authoritative — not local notes or chat context
- A linked PR is the single canonical follow-up artifact for the issue
- When an open linked PR exists, reuse it rather than opening another
- Implementation may proceed through either the GitHub-first routed path or the local implementation strategy (see [Public Dev Loop Contract](public-dev-loop-contract.md) `targetPreference`)

### Local-planning

**Persisted markdown plan files are the authoritative artifact store.** Work originates from a local markdown plan file in the repo working tree, and no GitHub issue is required. The plan file is authored, refined, and reviewed locally; it is committed during promotion (the helper sequence commits it as part of opening the PR), not before. GitHub PRs carry review and merge while the plan file stays the canonical spec.

Artifacts:
- **Planning artifact:** Persisted markdown plan file (e.g., `docs/phases/phase-<n>.md`); its format and required base sections are defined in the [Plan-file Contract](plan-file-contract.md)
- **Execution artifact:** Local branch and associated GitHub PR (created during implementation)
- **No GitHub issue:** The plan file replaces the issue as the canonical spec

Key contract:
- The markdown plan file is the canonical spec — not a duplicate of a tracker issue
- GitHub issues may still be used for tracking or linking, but the plan file is authoritative for scope and acceptance criteria
- A tracker-backed local implementation session (GitHub issue as canonical spec) must not also maintain a duplicate `docs/phases/phase-<n>.md` — see [Public Dev Loop Contract](public-dev-loop-contract.md) "Tracker-backed local implementation input-source contract"

### Mode selection table

| Mode | Canonical artifact | GitHub issue required | Settings value |
|---|---|---|---|
| Tracker-first | GitHub issue | Yes | `strategy.default: github-first` |
| Local-planning (shipped default) | Markdown plan file | No | `strategy.default: local-first` |

`inputSource.default` further disambiguates local-first startup:
| inputSource | Meaning |
|---|---|
| `tracker` (default) | Local agent implements from the GitHub issue body; no phase doc created |
| `phase-docs` | Local agent implements from persisted phase docs (e.g., `docs/phases/phase-<n>.md`) |

## Settings mechanism

The repo's default artifact-authority posture is declared by `strategy.default`, set in `.devloops` at repo root and resolved against the layered config defaults:

```yaml
# .devloops
strategy:
  default: local-first    # local-planning (markdown plan file)
  # default: github-first # tracker-first (GitHub issue required)
inputSource:
  default: tracker        # spec source for local-first: tracker (issue body) or phase-docs
```

The `strategy.default` key carries two jobs:
1. It declares the repo's default artifact-authority posture (local-planning under `local-first`, tracker-first under `github-first`).
2. It sets the routing preference (`targetPreference`) in dev-loop startup — `prefer_local` under `local-first`, `prefer_github_first` under `github-first`.

The authoritative artifact for a given run is selected by the explicit startup input. `scripts/loop/resolve-dev-loop-startup.mjs` takes `--issue` / `--pr` / `--input` / `--plan-file` (mutually exclusive), and `strategy.default` supplies the default routing preference; it does not force the artifact per invocation.

The `inputSource.default` key disambiguates local-first startup:
- `tracker` (default): the local agent implements from the GitHub issue body; the issue is the canonical spec
- `phase-docs`: the local agent implements from persisted phase docs; no tracker issue required

### Shipped default posture

The effective default for a consumer comes from the config-merge layering in `packages/core/src/config/config.mjs`. Precedence, low to high:

1. `BUILT_IN_DEFAULTS` (frozen in `config.mjs`) — `strategy.default: github-first`. This is the code-level fallback when no other layer sets the key.
2. Extension-packaged defaults (`packages/core/src/config/extension-defaults.yaml`, loaded as the `extensionDefaults` layer) — `strategy.default: local-first`. This is the opinion the package ships and the layer that wins over the built-in fallback.
3. Repo-local `.pi/dev-loop/defaults.*` (legacy) — applied when present.
4. Repo `.devloops` at repo root — the per-repo override, highest precedence. When `.devloops` is absent, the legacy `.pi/dev-loop/settings.*` / `overrides.*` apply at this position instead.

With nothing but the shipped package in place, the extension layer resolves `strategy.default` to `local-first`, so the shipped default posture is local-planning (epic #947, decision #7). A repo opts back into tracker-first by setting `strategy.default: github-first` in its own `.devloops`.

Two legacy repo-local layers also exist under `.pi/dev-loop/` (the package no longer ships a `.pi/dev-loop/defaults.yaml`). They differ in how they load: `.pi/dev-loop/defaults.*` is always applied when present, between the extension defaults and `.devloops`; `.pi/dev-loop/settings.*` (and the older `overrides.*`) load only when no `.devloops` is present — when `.devloops` exists it is authoritative and those files are ignored (with a deprecation warning). The full precedence, low to high, is: `BUILT_IN_DEFAULTS` < extension defaults < `.pi/dev-loop/defaults.*` < repo `.devloops` (or, when `.devloops` is absent, `.pi/dev-loop/settings.*` / `overrides.*`).

### Explicit non-knobs

These are not valid artifact authority mode selectors:
- `strategy.default: copilot` — not a valid mode; the enum accepts only `github-first` or `local-first` (`packages/core/src/config/config.mjs`)
- Free-form string values — fail closed
- Omitting `strategy.default` from every layer — resolves to `github-first` from `BUILT_IN_DEFAULTS`; with the shipped extension layer present it resolves to `local-first`

## Local-first plan-file flow end to end

Under local-planning, one plan file moves through four stages. Each stage has a shipped helper script and a pure core contract; the [Local-Planning Flow](local-planning-flow.md) skill doc walks the same sequence as operator steps, and the [Local-Planning Worked Example](local-planning-worked-example.md) shows one plan file evolving through every stage.

### P1 — Plan-file artifact + config (#949)

The plan file is a phase-doc-format markdown document. Its directory is `localPlanning.plansDir`, which defaults to `docs/phases/` (built-in default in `config.mjs`, mirrored in `extension-defaults.yaml`; `resolvePlansDir(config)` resolves it). Its required base authoring sections — `## Status`, `## Objective`, `## In scope`, `## Explicit non-goals` — and the validator `scripts/refine/validate-plan-file.mjs` (`validatePlanFile`, distinct `missing_*` codes per absent or empty section) are defined in the [Plan-file Contract](plan-file-contract.md).

### P2 — Intake (#950)

`scripts/loop/resolve-dev-loop-startup.mjs` accepts `--plan-file <path>` (mutually exclusive with `--issue`, `--pr`, `--input`). It validates the plan and threads an intake state onto its output. The pure contract `@dev-loops/core/loop/plan-file-intake-contract` (`packages/core/src/loop/plan-file-intake-contract.mjs`) defines `evaluatePlanFileIntakeState` and the three `PLAN_FILE_INTAKE_STATE` values:

| State | Meaning |
|---|---|
| `new_plan_needs_refinement` | Base sections valid; the refinement sections are not yet present |
| `plan_refined_ready_for_promotion` | Base sections valid and both `PLAN_FILE_REFINEMENT_SECTIONS` (`Acceptance criteria`, `Definition of done`) present |
| `ambiguous_fail_closed` | Base sections invalid, or only one refinement section present — the resolver does not route the plan forward |

In the CLI, a base-valid plan carrying only one refinement section is reported as `ambiguous_fail_closed` with exit 0 (the operator completes the missing section before refine/promote); a missing/unreadable plan, or one that fails the base-section validator, makes startup exit 1 with no readiness bundle.

### P3 — Local refine + review checkpoint (#951)

`scripts/refine/refine-plan-file.mjs` drives the refine step; the pure contract `@dev-loops/core/loop/plan-file-refine-contract` (`packages/core/src/loop/plan-file-refine-contract.mjs`) exports `refinePlanFileInPlace`, which writes the refiner payload back into the single canonical plan file in place — the `Acceptance criteria` and `Definition of done` sections, a `Coverage matrix` section (`COVERAGE_MATRIX_HEADING`), and a `Docs-grill findings` section (`DOCS_GRILL_FINDINGS_HEADING`) — then stops at the `local_human_review` checkpoint (`PLAN_FILE_REFINE_STOP.LOCAL_HUMAN_REVIEW`) with the intake state advanced to `plan_refined_ready_for_promotion`. The module performs no GitHub mutation, no network calls, and no filesystem I/O; the caller reads and writes the plan file. The docs-grill runs as a step within refinement: the CLI classifies each finding with `classifyDocsGrillFinding` (`scripts/loop/docs-grill-contract.mjs`) and the contract records the dispositions. See the [Docs-Grill Step](../../docs/docs-grill-step.md).

### P4 — Promotion + authority transfer (#952)

`scripts/refine/promote-plan.mjs` promotes a refined plan; the pure contract `@dev-loops/core/loop/plan-file-promote-contract` (`packages/core/src/loop/plan-file-promote-contract.mjs`) exports `evaluatePromoteEligibility` and `buildPromotionPrBody`. Promotion is PR-first: it commits the plan doc and opens exactly one draft PR via the canonical PR wrapper, and mints no GitHub issue. The plan↔PR link is bidirectional — the PR body carries the committed plan-doc path (the spec-of-record) and the plan front-matter carries `prNumber:` (`PLAN_FILE_PR_FRONT_MATTER_KEY`). Promotion is idempotent: a plan that already carries `prNumber` resolves to `already_promoted` (`PLAN_FILE_PROMOTE_ACTION.ALREADY_PROMOTED`) and opens nothing. The optional `prNumber` front-matter and its parser/serializer are described in the [Plan-file Contract](plan-file-contract.md).

### P5 — Local-first noise profile (#953)

The shipped extension layer pairs local-first with a low-noise posture, in `packages/core/src/config/extension-defaults.yaml`:

| Key | Shipped value | Why |
|---|---|---|
| `strategy.default` | `local-first` | The shipped default posture (decision #7) |
| `autonomy.humanMergeOnly` | `true` | Local-first never auto-merges; a human always merges |
| `queue.maxAutoFiledIssues` | `1` | Local-first is PR-first, so auto-filing issues is near-zero; a low cap keeps tracker noise minimal |
| `gates.postFindingsComments` | `true` | Gate findings live on the PR (the spec-of-record and human-review surface) as evidence |

These values come from the existing config-merge layering, so no new resolver is involved: `BUILT_IN_DEFAULTS` keeps the github-first posture (`humanMergeOnly: false`, `maxAutoFiledIssues: 10`), and the extension layer sets the local-first values above. A repo `.devloops` can override any of them.

## dev-loops own mode

dev-loops runs **local-planning**, set in its repo-root `.devloops`.

- **Mode:** Local-planning
- **Settings:** repo-root `.devloops` sets `strategy.default: local-first` and `inputSource.default: tracker`
- **Artifact authority:** the canonical spec for a work item is its plan artifact; the repo dogfoods the same local-first posture the package ships as default
- **Per-run input:** with `inputSource.default: tracker`, a local-first session can still implement from a GitHub issue body when one is supplied (the issue is the spec source for that run); `phase-docs` switches the source to a committed plan file
- **Why local-planning:** the repo runs the local-first plan-file flow (plan-file → refine → review → promote) on its own work so the shipped default posture is exercised end to end.

## Relationship to other docs

| Doc | Relationship |
|---|---|
| [Public Dev Loop Contract](public-dev-loop-contract.md) | This contract is the canonical entrypoint; artifact authority contract defines the artifact model it assumes |
| [Plan-file Contract](plan-file-contract.md) | Defines the plan-file format (phase-doc format) and its required base sections for local-planning mode |
| [Local-Planning Flow](local-planning-flow.md) | Operator sequence for the local-first flow: validate → start → refine → promote, naming the shipped helper scripts |
| [Local-Planning Worked Example](local-planning-worked-example.md) | One plan file shown through every stage, with the file content evolving |
| [Tracker-First Loop State](tracker-first-loop-state.md) | Defines the PR-level state machine for tracker-first PR workflows; that is execution state, separate from artifact authority |
| [Main Agent Contract](main-agent-contract.md) | Defines the delegation boundary; artifact authority defines which artifacts govern work |
| AGENTS.md | Repo constitution; cites the work-origin rule and points to this contract |
| [Dev Loop Skill](../dev-loop/SKILL.md) | Public entrypoint skill; cites the work-origin rule and points to this contract |

### Distinction: artifact authority vs tracker-first PR workflow

`tracker-first-loop-state.md` defines a state machine for PR lifecycle management when a tracker item (e.g., Shortcut story) drives a GitHub PR. It is a **PR-level workflow contract**. The term "tracker-first" there refers to tracker-driven PR state transitions, a separate concern from the artifact authority model this doc defines.

## Non-goals

- Defining tracker adapters or multi-tracker support
- Specifying how PRs map to issues in detail (that is the [Public Dev Loop Contract](public-dev-loop-contract.md))
- Changing the dev-loop startup resolver behavior
- Adding tracker-specific settings beyond `inputSource` — further tracker adapters or multi-tracker support remain out of scope
