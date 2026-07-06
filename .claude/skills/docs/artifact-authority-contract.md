# Artifact authority contract

Canonical owner for the artifact-selection model: whether a work item originates from a GitHub issue (tracker-first) or from a persisted markdown plan file (local-planning).

This canonical owner lives in the shipped `skills/docs/` surface because installed skill/runtime consumers reliably own the skills subtree. In installed layouts, read the same contract via [Artifact Authority Contract](../docs/artifact-authority-contract.md) from the installed skill directory.

Other repo docs may summarize or link this contract, but they should not redefine it.

## Two-tier model

<!-- rule: ARTIFACT-TWO-TIER-EXCLUSIVE -->
dev-loops supports two mutually exclusive artifact authority modes. Every work item MUST originate from exactly one authoritative artifact: a GitHub issue or a persisted markdown plan file. Work MUST NOT originate from a PR or a direct local change unless explicitly requested.

The shipped extension default selects local-planning; see [Shipped default posture](#shipped-default-posture) below. The mode names that follow describe the two tiers; "default" in their headings refers to the local-first code-level default in `BUILT_IN_DEFAULTS`.

### Tracker-first

**GitHub issues are the authoritative artifact store.** Work originates from a GitHub issue. A linked PR is the execution artifact. GitHub is the canonical source of truth for issue identity, acceptance criteria, scope, and lifecycle state.

Artifacts:
- **Planning artifact:** GitHub issue (title, body, labels, assignees, acceptance criteria)
- **Execution artifact:** GitHub PR (linked to issue; created during implementation)
- <!-- rule: ARTIFACT-TRACKER-FIRST-NO-DUP --> **No local duplicate:** A tracker-first session MUST NOT create `docs/phases/phase-<n>.md` for the same session when a GitHub issue is the canonical spec

Key contract:
- GitHub issue state is authoritative — not local notes or chat context
- A linked PR is the single canonical follow-up artifact for the issue
- When an open linked PR exists, reuse it rather than opening another
- Follow-ups discovered while working a PR/loop are noted on the originating issue or PR body by default; a standalone issue is filed only when the follow-up is genuinely independent of the PR and outlives it (see [Sub-Issue Tree Contract](../../docs/sub-issue-tree-contract.md))
- Implementation may proceed through either the GitHub-first routed path or the local implementation strategy (see [Public Dev Loop Contract](public-dev-loop-contract.md) `targetPreference`)

### Local-planning

**Persisted markdown plan files are the authoritative artifact store.** Work originates from a local markdown plan file in the repo working tree, and no GitHub issue is required. The plan file stays uncommitted through authoring, refinement, and local review; promotion is the step that commits it (the helper sequence commits it as part of opening the PR). GitHub PRs carry review and merge while the plan file stays the canonical spec.

Artifacts:
- **Planning artifact:** Persisted markdown plan file (e.g., `docs/phases/phase-<n>.md`); its format and required base sections are defined in the [Plan-file Contract](plan-file-contract.md)
- **Execution artifact:** Local branch and associated GitHub PR (created during implementation)
- **No GitHub issue:** The plan file replaces the issue as the canonical spec

Key contract:
- The markdown plan file is the canonical spec — not a duplicate of a tracker issue
- GitHub issues may still be used for tracking or linking, but the plan file is authoritative for scope and acceptance criteria
- A tracker-backed local implementation session (GitHub issue as canonical spec) is bound by [ARTIFACT-TRACKER-FIRST-NO-DUP](#tracker-first) above — see [Public Dev Loop Contract](public-dev-loop-contract.md) "Tracker-backed local implementation input-source contract"

### Lightweight (PR-body-as-spec)

**The PR description itself is the authoritative artifact store — no committed plan artifact.** This is a lightweight modifier on the local `--issue` path (`resolve-dev-loop-startup.mjs --issue <n> --lightweight`, `canonicalSpecSource: pr_body`), not a settings-level mode. No phase/plan doc is minted or committed; the PR body carries the spec-of-record invariants directly. The gate sequence is identical to the phase-doc path (draft → pre-approval fanout → detect-evidence → human merge); only the backing artifact differs (PR body vs phase doc).

Artifacts:
- **Planning + execution artifact:** the GitHub PR — its description is the spec, its diff is the execution
- **No committed plan doc:** no `docs/phases/*.md` is created for the session

Key contract:
- <!-- rule: ARTIFACT-LIGHTWEIGHT-BODY-INVARIANTS --> The PR body MUST carry the same invariants a durable spec would: **Objective/why, in-scope + explicit non-goals, testable acceptance criteria, definition of done, open questions/risks** — unconditionally, whether or not the work is tracker-backed. The `Closes #N` linkage (GitHub's other closing keywords count too) is conditional on artifact backing (operator ruling, issue #1210): REQUIRED when the work originates from a GitHub issue (`--issue --lightweight`), ABSENT BY DESIGN when the PR is the sole artifact with no backing issue (`--lightweight` alone, issue-less PR-first) — an issue-less PR body MUST NOT carry a closing reference to an issue that doesn't back it. `scripts/loop/validate-pr-body-spec.mjs` (reusing the generic markdown logic of `@dev-loops/core/loop/issue-refinement-artifact`, `validatePrBodySpec`) validates these and fails closed with a distinct reason per violated invariant — `missing_closing_issue_reference` without the linkage in tracker-backed mode, `closes_wrong_issue` when an `--expected-issue` is given and doesn't match, `unexpected_closing_issue_reference` when a closing reference is present under explicit issue-less mode (`--no-issue`) — so the lightweight path's issue-tracking state never silently diverges from PR state (issue #1181).
- This flips the promotion invariant below (P4, "the PR body carries the committed plan-doc **path**"): under lightweight there is no committed plan doc — the PR body **is** the spec, not a pointer to one.
- The explicit `--lightweight` flag is the primary, deterministic trigger. The secondary heuristic (chore/fix commit type + no `--plan-file` + small change) is a documented manual signal for when to reach for the flag; it is not an automatic selector.
- <!-- rule: ARTIFACT-LIGHTWEIGHT-PLAN-FILE-EXCLUSIVE --> `--lightweight` MUST be rejected when combined with `--plan-file` (they are opposites: `--plan-file` commits a durable plan doc as the spec, `--lightweight` makes the PR body the spec). It composes with `--issue` (tracker-backed) or stands alone (issue-less PR-first, #1210 — gated on `localImplementation.lightMode` being enabled and the change scope staying within its threshold); it MUST be rejected when combined with any other mode flag (`--pr`, `--input`, `--spike`).
- Pre-approval acceptance-criteria verification reads the AC/DoD/invariants directly from the PR body rather than a linked issue body; see [Acceptance Criteria Verification](acceptance-criteria-verification.md).

### Mode selection table

| Mode | Canonical artifact | GitHub issue required | Settings value |
|---|---|---|---|
| Tracker-first | GitHub issue | Yes | `strategy.default: github-first` |
| Local-planning (shipped default) | Markdown plan file | No | `strategy.default: local-first` |
| Lightweight (PR-body-as-spec) | GitHub PR description | Conditional — `--issue` when tracker-backed; absent for issue-less PR-first (#1210), gated on `localImplementation.lightMode` + change-scope threshold | modifier: `--lightweight` (`canonicalSpecSource: pr_body`) |

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

1. `BUILT_IN_DEFAULTS` (frozen in `config.mjs`) — `strategy.default: local-first`. This is the code-level fallback when no other layer sets the key.
2. Extension-packaged defaults (`packages/core/src/config/extension-defaults.yaml`, loaded as the `extensionDefaults` layer) — `strategy.default: local-first`. This is the opinion the package ships and the layer that wins over the built-in fallback.
3. Repo-local `.pi/dev-loop/defaults.*` (legacy) — applied when present.
4. Repo `.devloops` at repo root — the per-repo override, highest precedence. When `.devloops` is absent, the legacy `.pi/dev-loop/settings.*` / `overrides.*` apply at this position instead.

With nothing but the shipped package in place, the extension layer resolves `strategy.default` to `local-first`, so the shipped default posture is local-planning (epic #947, decision #7). A repo opts back into tracker-first by setting `strategy.default: github-first` in its own `.devloops`.

Two legacy repo-local layers also exist under `.pi/dev-loop/` (the package no longer ships a `.pi/dev-loop/defaults.yaml`). They differ in how they load, per the precedence list above: `.pi/dev-loop/defaults.*` is always applied when present, between the extension defaults and `.devloops`; `.pi/dev-loop/settings.*` (and the older `overrides.*`) load only when no `.devloops` is present — when `.devloops` exists it is authoritative and those files are ignored (with a deprecation warning).

### Explicit non-knobs

<!-- rule: ARTIFACT-STRATEGY-ENUM-FAIL-CLOSED -->
`ARTIFACT-STRATEGY-ENUM-FAIL-CLOSED`: The strategy enum MUST accept only `github-first` or `local-first` and MUST fail closed on any other value (`packages/core/src/config/config.mjs`). These are not valid artifact authority mode selectors:
- `strategy.default: copilot` — not a valid mode
- Free-form string values — MUST fail closed
- Omitting `strategy.default` from every layer — resolves to `local-first` from `BUILT_IN_DEFAULTS`

## Local-first plan-file flow end to end

Under local-planning, one plan file moves through four stages. Each stage has a shipped helper script; the start, refine, and promote stages also expose their pure logic as an `@dev-loops/core` contract, while the validate stage's `validatePlanFile` lives in its helper script (`scripts/refine/validate-plan-file.mjs`). The [Local-Planning Flow](local-planning-flow.md) skill doc walks the same sequence as operator steps, and the [Local-Planning Worked Example](local-planning-worked-example.md) shows one plan file evolving through every stage.

### P1 — Plan-file artifact + config (#949)

The plan file is a phase-doc-format markdown document. It lives under `docs/phases/`, the existing phase-docs directory. Its required base authoring sections — `## Status`, `## Objective`, `## In scope`, `## Explicit non-goals` — and the validator `scripts/refine/validate-plan-file.mjs` (`validatePlanFile`, distinct `missing_*` codes per absent or empty section) are defined in the [Plan-file Contract](plan-file-contract.md).

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
| [Spike-mode Contract](spike-mode-contract.md) | Time-boxed exploratory runs; a graduated spike emits a plan file that enters this local-planning tier |
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
