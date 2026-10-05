# Artifact authority contract

Canonical owner for the artifact-selection model: whether a work item originates from a GitHub issue (tracker-first), a persisted markdown plan file (local-planning), or the sanctioned lightweight PR-body-as-spec path. Installed layouts read the same contract via [Artifact Authority Contract](../docs/artifact-authority-contract.md) from the installed skill directory. Other repo docs may summarize or link this contract, but they should not redefine it.

## Three-origin model

<!-- rule: ARTIFACT-TWO-TIER-EXCLUSIVE -->
<!-- The rule ID predates the three-origin wording below (it was written when the
     model was two-tier); retained as-is for ID stability, not renamed. -->
dev-loops supports three mutually exclusive artifact authority origins. Every work item MUST originate from exactly one authoritative artifact: a GitHub issue, a persisted markdown plan file, or — on the sanctioned lightweight path — the PR description itself as the spec-of-record (no committed plan artifact). Work MUST NOT originate from a PR (other than the sanctioned lightweight PR-body-as-spec path) or a direct local change unless explicitly requested.

The shipped extension default selects local-planning; see [Shipped default posture](#shipped-default-posture) below. The mode names that follow describe the origins; "default" in their headings refers to the local-first code-level default in `BUILT_IN_DEFAULTS`.

### Tracker-first

**GitHub issues are the authoritative artifact store.** Work originates from a GitHub issue. A linked PR is the execution artifact. GitHub is the canonical source of truth for issue identity, acceptance criteria, scope, and lifecycle state.

Artifacts:
- **Planning artifact:** GitHub issue (title, body, labels, assignees, acceptance criteria)
- **Execution artifact:** GitHub PR (linked to issue; created during implementation)
- <!-- rule: ARTIFACT-TRACKER-FIRST-NO-DUP --> **No local duplicate:** A tracker-first session MUST NOT create `docs/phases/phase-<n>.md` for the same session when a GitHub issue is the canonical spec
- <!-- rule: ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR --> A refined tracker-backed issue body MUST carry the authoritative semantic AC→DoD mapping **matrix** — a two-column table mapping each acceptance-criterion outcome to its required completion evidence — plus an explicit, non-empty `## Non-goals` section (#1951, "matrix on the issue, checklist on the PR"). Issue-side Acceptance criteria / Definition of done CHECKLISTS are NOT required for detection. The PR carries the derived self-contained list-form AC/DoD checkboxes (never a matrix/table on the PR, never checkboxes inside table cells). The deterministic predicate `detectIssueRefinementArtifact` (`@dev-loops/core/loop/issue-refinement-artifact`, via `detectAcDodMatrix`) validates the mapping table's PRESENCE and SHAPE fail-closed with distinct findings — `missing_ac_dod_matrix` (AC/DoD content present but no mapping table, including a checklist-only issue), `malformed_ac_dod_matrix` (a table that is empty, or identifier-only/tautological such as `AC1 → D1`), and `missing_explicit_non_goals` (#1866). The predicate checks completeness and shape only; loop-grill authors semantic correctness at refinement and reviewers verify it (the `pr-checklist` angle). The requirement extends the epic-only AC/DoD matrix contract (epic-tree-refinement-procedure.md) to all tracker-backed issues. A linked `tmp/refinement/*.md` doc satisfies the artifact check only when it actually resolves on disk (enqueue gate and draft-gate linked-issue path) and itself carries the matrix; the issue-less / PR-body spec path is unchanged.
  - **Migration (#1951):** the parser still extracts AC/DoD checklist content from existing issues, but a body carrying only checklists and no mapping matrix fails closed with `missing_ac_dod_matrix` and is re-grilled (loop-grill synthesizes the matrix). No compatibility alias for the obsolete checklist floor is retained. PR-side validation (`validateTrackerBackedPrBodySpec`) and the pre-approval unchecked-box block (`extractPrBodyUncheckedChecklistItems`) keep reading the PR's list-form checklists.

Key contract:
- GitHub issue state is authoritative — not local notes or chat context
- A linked PR is the single canonical follow-up artifact for the issue
- When an open linked PR exists, reuse it rather than opening another
- Follow-ups discovered while working a PR/loop are noted on the originating issue or PR body by default; a standalone issue is filed only when the follow-up is genuinely independent of the PR and outlives it (see [Sub-Issue Tree Contract](./sub-issue-tree-contract.md))
- Implementation may proceed through either the GitHub-first routed path or the local implementation strategy (see [Public Dev Loop Contract](public-dev-loop-contract.md) `targetPreference`)

### Local-planning

**Persisted markdown plan files are the authoritative artifact store.** Work originates from a local markdown plan file in the repo working tree, and no GitHub issue is required. The plan file stays uncommitted through authoring, refinement, and local review; promotion is the step that commits it (the helper sequence commits it as part of opening the PR). GitHub PRs carry review and merge while the plan file stays the canonical spec.

Artifacts:
- **Planning artifact:** Persisted markdown plan file (e.g., `docs/phases/phase-<n>.md`); its format and required base sections are defined in the [Plan-file Contract](local-planning.md#plan-file-contract)
- **Execution artifact:** Local branch and associated GitHub PR (created during implementation)
- **No GitHub issue:** The plan file replaces the issue as the canonical spec

Key contract:
- The markdown plan file is the canonical spec — not a duplicate of a tracker issue
- GitHub issues may still be used for tracking or linking, but the plan file is authoritative for scope and acceptance criteria
- A tracker-backed local implementation session (GitHub issue as canonical spec) is bound by [ARTIFACT-TRACKER-FIRST-NO-DUP](#tracker-first) above — see [Public Dev Loop Contract](public-dev-loop-contract.md) "Tracker-backed local implementation input-source contract"

### Lightweight (PR-body-as-spec)

**The PR description itself is the authoritative artifact store — no committed plan artifact.** This is a lightweight modifier on the local `--issue` path (`resolve-dev-loop-startup.mjs --issue <n> --lightweight`, `canonicalSpecSource: pr_body`), not a settings-level mode. The gate sequence is identical to the phase-doc path (draft → pre-approval fanout → detect-evidence → human merge); only the backing artifact differs.

Artifacts:
- **Planning + execution artifact:** the GitHub PR — its description is the spec, its diff is the execution
- **No committed plan doc:** no `docs/phases/*.md` is created for the session

Key contract:
- <!-- rule: ARTIFACT-LIGHTWEIGHT-BODY-INVARIANTS --> The PR body MUST carry the same invariants a durable spec would: **Objective/why, in-scope + explicit non-goals, testable acceptance criteria, definition of done, open questions/risks** — unconditionally, whether or not the work is tracker-backed. The `Closes #N` linkage (GitHub's other closing keywords count too) is conditional on artifact backing (operator ruling, issue #1210): REQUIRED when the work originates from a GitHub issue (`--issue --lightweight`), ABSENT BY DESIGN when the PR is the sole artifact with no backing issue (`--lightweight` alone, issue-less PR-first) — an issue-less PR body MUST NOT carry a closing reference to an issue that doesn't back it. `scripts/loop/validate-pr-body-spec.mjs` (reusing the generic markdown logic of `@dev-loops/core/loop/issue-refinement-artifact`, `validatePrBodySpec`) validates these and fails closed with a distinct reason per violated invariant — `missing_closing_issue_reference` without the linkage in tracker-backed mode, `closes_wrong_issue` when an `--expected-issue` is given and doesn't match, `unexpected_closing_issue_reference` when a closing reference is present under explicit issue-less mode (`--no-issue`) — so the lightweight path's issue-tracking state never silently diverges from PR state (issue #1181).
- Unlike promotion (P4), where the PR body carries the committed plan-doc **path**, the lightweight PR body **is** the spec.
- The explicit `--lightweight` flag is the only deterministic trigger. A chore/fix commit type with no `--plan-file` and a small change is a manual signal to reach for the flag, not an automatic selector.
- <!-- rule: ARTIFACT-LIGHTWEIGHT-PLAN-FILE-EXCLUSIVE --> `--lightweight` MUST be rejected when combined with `--plan-file` (they are opposites: `--plan-file` commits a durable plan doc as the spec, `--lightweight` makes the PR body the spec). It composes with `--issue` (tracker-backed) or stands alone (issue-less PR-first, #1210 — gated on `localImplementation.lightMode` being enabled and the change scope staying within its threshold, unless `localImplementation.issueless` (#1349) sanctions issue-less PR-first at any change scope for consumers whose spec of record lives in an external tracker; review depth stays scope-driven — gate dispatch still resolves inline vs full fan-out from the light-mode threshold, and over-threshold PRs keep the full-PR Copilot round cap); it MUST be rejected when combined with any other mode flag (`--pr`, `--input`, `--spike`).
- Pre-approval acceptance-criteria verification reads the AC/DoD/invariants directly from the PR body rather than a linked issue body; see [Acceptance Criteria Verification](acceptance-criteria-verification.md).

### Mode selection table

| Mode | Canonical artifact | GitHub issue required | Settings value |
|---|---|---|---|
| Tracker-first | GitHub issue | Yes | `strategy: tracker-first` (`github-first` is a deprecated accepted alias) |
| Local-planning (shipped default) | Markdown plan file | No | `strategy: local-first` |
| Lightweight (PR-body-as-spec) | GitHub PR description | Conditional — `--issue` when tracker-backed; absent for issue-less PR-first (#1210), gated on `localImplementation.lightMode` + change-scope threshold, or any-scope with `localImplementation.issueless` (#1349) | modifier: `--lightweight` (`canonicalSpecSource: pr_body`) |

`inputSource` further disambiguates local-first startup:
| inputSource | Meaning |
|---|---|
| `tracker` (default) | Local agent implements from the GitHub issue body; no phase doc created |
| `phase-docs` | Local agent implements from persisted phase docs (e.g., `docs/phases/phase-<n>.md`) |

## Settings mechanism

The repo's default artifact-authority posture is declared by `strategy`, set in `.devloops` at repo root and resolved against the layered config defaults:

```yaml
# .devloops
strategy: local-first     # local-planning (markdown plan file)
# strategy: tracker-first # tracker-first (GitHub issue required; "github-first" is a deprecated accepted alias)
inputSource: tracker      # spec source for local-first: tracker (issue body) or phase-docs
```

The `strategy` key declares the repo's default artifact-authority posture and sets the startup routing preference (`targetPreference`): `prefer_local` under `local-first`, `prefer_github_first` under `tracker-first`. The explicit startup input selects the authoritative artifact for a run: `scripts/loop/resolve-dev-loop-startup.mjs` takes `--issue` / `--pr` / `--input` / `--plan-file` (mutually exclusive); `strategy` does not force the artifact per invocation. `inputSource` is defined in the table above.

### Shipped default posture

The effective default for a consumer comes from the config-merge layering in `packages/core/src/config/config.mjs`. Precedence, low to high:

1. `BUILT_IN_DEFAULTS` (frozen in `config.mjs`) — `strategy: local-first`, the code-level fallback.
2. Extension-packaged defaults (`packages/core/src/config/extension-defaults.yaml`, loaded as the `extensionDefaults` layer) — `strategy: local-first`.
3. Repo-local legacy `.pi/dev-loop/defaults.*` — applied when present (the package no longer ships one).
4. Repo `.devloops` at repo root — the per-repo override, highest precedence.

The shipped default posture is therefore local-planning (epic #947, decision #7). A repo opts into tracker-first by setting `strategy: tracker-first` in its own `.devloops` (`github-first` is a deprecated accepted alias, normalized with a load-time warning). The old `.pi/dev-loop/settings.*` / `overrides.*` layers were removed at the v1.0.0 cut (ADR 0017) and are ignored.

### Explicit non-knobs

<!-- rule: ARTIFACT-STRATEGY-ENUM-FAIL-CLOSED -->
`ARTIFACT-STRATEGY-ENUM-FAIL-CLOSED`: The strategy enum MUST accept only `tracker-first` or `local-first` (plus the deprecated accepted alias `github-first`, normalized to `tracker-first` with a warning) and MUST fail closed on any other value (`packages/core/src/config/config.mjs`). These are not valid artifact authority mode selectors:
- `strategy: copilot` — not a valid mode
- Free-form string values — MUST fail closed
- Omitting `strategy` from every layer — resolves to `local-first` from `BUILT_IN_DEFAULTS`

### Config load failure

<!-- rule: CONFIG-LOAD-FAIL-CLOSED -->
`CONFIG-LOAD-FAIL-CLOSED`: A config load error MUST NOT relax a gate decision. `loadDevLoopConfig` never throws. On an unknown key it drops the whole `.devloops` layer and returns `errors`. The loader error text names each unknown key and the running dev-loops version, and, for a key without a rename record, states that the key needs a newer dev-loops. Inside a dev-loops source checkout it also names the checkout `package.json` version. A key that a later release renamed also names the new key and the renaming release. A removed raw `gates.<gate>.mandatoryAngles` or `excludeAngles` key gets the angle-entry migration hint instead of the newer-dev-loops text. `configLoadFailure` in `@dev-loops/core/config` builds the shared outcome `{ reason: "config_load_failed", errors, unknownKeys, runningVersion, checkoutVersion }`. Startup returns it as `bundle.configError` inside the existing `needs_reconcile` kind. A CLI script row whose decision is `Fail closed: config_load_failed` exits non-zero with a CLI payload `{ ok: false, error, code: "config_load_failed", configError }`. Every other fail-closed row keeps the refusal shape its row names. A `config_load_failed` startup stops at its `nextAction`, and `loop build-envelope` refuses it with `config_load_failed`. Every script under `scripts/` and `cli/` that calls `loadDevLoopConfig` has exactly one row below. A conformance test fails on a caller without a row.

| Script | Decision on a config error |
|---|---|
| `scripts/loop/resolve-dev-loop-startup.mjs` | Fail closed: `needs_reconcile` with `configError` |
| `scripts/loop/detect-pr-gate-coordination-state.mjs` | Fail closed: `config_load_failed` |
| `scripts/loop/detect-copilot-loop-state.mjs` | Fail closed: `config_load_failed` |
| `scripts/loop/copilot-pr-handoff.mjs` | Fail closed: `config_load_failed` |
| `scripts/github/request-copilot-review.mjs` | Fail closed: `config_load_failed` |
| `scripts/github/write-gate-context.mjs` | Fail closed: `config_load_failed` |
| `scripts/github/write-gate-findings-log.mjs` | Fail closed: `config_load_failed` |
| `scripts/github/resolve-angle-carry-forward.mjs` | Fail closed: `config_load_failed` |
| `scripts/loop/resolve-gate-dispatch.mjs` | Fail closed: `config_load_failed` |
| `scripts/github/detect-checkpoint-evidence.mjs` | Fail closed: `config_load_failed` |
| `scripts/github/emit-fanout-dispatch.mjs` | Fail closed: `config_load_failed` |
| `scripts/github/reconcile-draft-gate.mjs` | Fail closed: `config_load_failed` |
| `scripts/loop/emit-judge-work-order.mjs` | Fail closed: `config_load_failed` |
| `scripts/loop/build-handoff-envelope.mjs` | Fail closed: `config_load_failed` |
| `scripts/github/ready-for-review.mjs` | Fail closed: `config_load_failed` on its own load, plus the size budget block |
| `scripts/loop/judge-pass.mjs` | Fail closed: throws |
| `scripts/loop/consolidate-fanin.mjs` | Fail closed: throws with `--gate` |
| `scripts/github/upsert-checkpoint-verdict.mjs` | Fail closed: throws |
| `scripts/github/merge-pr.mjs` | Fail closed: refuses with `configError` |
| `scripts/docs/validate-changelog-completeness.mjs` | Fail closed: throws |
| `scripts/github/withdraw-copilot-review-request.mjs` | Fail closed: throws |
| `scripts/loop/check-size-budget.mjs` | Fail closed: outcome `block`, no waiver |
| `scripts/loop/emit-fixer-work-order.mjs` | Fail closed: refusal |
| `scripts/loop/claude-launch.mjs` | Fail closed: `fail()` |
| `scripts/claude/headless-dev-loop.mjs` | Fail closed: `ok: false` |
| `scripts/loop/run-queue.mjs` | Fail closed for merge authorization |
| `scripts/loop/resolve-reviewer-role.mjs` | Fail closed: `ok: false` |
| `scripts/loop/detect-change-scope.mjs` | Default `eligible=false`, no light mode |
| `scripts/github/post-gate-findings.mjs` | Default `postFindingsComments=false`, step skipped |
| `scripts/github/close-gate-findings.mjs` | Default `mediumFixWindow=3`, `inlineSeverityFloor=medium`, `trackerProvider=null` |
| `scripts/loop/provision-worktree.mjs` | Default: no copy or link actions |
| `scripts/loop/outer-loop.mjs` | Default `asyncStartMode=required`, then fail closed: `config_load_failed` through `_loop-evidence.mjs` |
| `scripts/loop/resolve-human-merge-only.mjs` | Default `humanMergeOnly=true` |
| `scripts/refine/refine-plan-file.mjs` | Default: advisory warning |
| `scripts/github/create-pr.mjs` | Not a gate decision: base branch falls back to the default |
| `scripts/github/offer-human-handoff.mjs` | Not a gate decision: handoff candidates only |
| `scripts/github/resolve-handoff-candidates.mjs` | Not a gate decision: handoff candidates only |
| `scripts/github/resolve-tracker-local-spec.mjs` | Not a gate decision: default tracker adapter |
| `scripts/loop/_loop-evidence.mjs` | Fail closed: library module that throws `ConfigLoadFailedError` to its caller |
| `scripts/loop/detect-agent-stall.mjs` | Not a gate decision: stall detection setting |
| `scripts/loop/inspect-run-viewer/server.mjs` | Not a gate decision: read-only viewer |
| `scripts/loop/inspect-run.mjs` | Not a gate decision: read-only report; a `config_load_failed` from Copilot evidence drops that evidence and is named in the report missing marker, with no default fallback |
| `scripts/loop/print-gates.mjs` | Not a gate decision: prints gate settings |
| `scripts/loop/run-post-merge-actions.mjs` | Not a gate decision: post-merge actions run after the merge |
| `scripts/loop/spec-context.mjs` | Not a gate decision: default tracker adapter |
| `scripts/loop/ui-review-drive.mjs` | Not a gate decision: no recipe drives nothing |
| `scripts/loop/ui-review-provision.mjs` | Not a gate decision: UI review recipe |
| `scripts/loop/ui-review-teardown.mjs` | Not a gate decision: UI review recipe |
| `scripts/loop/visual-grill-capture.mjs` | Not a gate decision: capture recipe |
| `scripts/refine/promote-plan.mjs` | Not a gate decision: base branch |

## Local-first plan-file flow end to end

Under local-planning, one plan file moves through four stages. Each stage has a shipped helper script; the start, refine, and promote stages also expose their pure logic as an `@dev-loops/core` contract, while the validate stage's `validatePlanFile` lives in its helper script (`scripts/refine/validate-plan-file.mjs`). The [Local-Planning Flow](local-planning.md#local-planning-flow) skill doc walks the same sequence as operator steps, and the [Local-Planning Worked Example](local-planning.md#local-planning-worked-example) shows one plan file evolving through every stage.

### P1 — Plan-file artifact + config (#949)

The plan file is a phase-doc-format markdown document. It lives under `docs/phases/`, the existing phase-docs directory. Its required base authoring sections — `## Status`, `## Objective`, `## In scope`, `## Explicit non-goals` — and the validator `scripts/refine/validate-plan-file.mjs` (`validatePlanFile`, distinct `missing_*` codes per absent or empty section) are defined in the [Plan-file Contract](local-planning.md#plan-file-contract).

### P2 — Intake (#950)

`scripts/loop/resolve-dev-loop-startup.mjs` accepts `--plan-file <path>` (mutually exclusive with `--issue`, `--pr`, `--input`). It validates the plan and threads an intake state onto its output. The pure contract `@dev-loops/core/loop/plan-file-intake-contract` (`packages/core/src/loop/plan-file-intake-contract.mjs`) defines `evaluatePlanFileIntakeState` and the three `PLAN_FILE_INTAKE_STATE` values:

| State | Meaning |
|---|---|
| `new_plan_needs_refinement` | Base sections valid; the refinement sections are not yet present |
| `plan_refined_ready_for_promotion` | Base sections valid and both `PLAN_FILE_REFINEMENT_SECTIONS` (`Acceptance criteria`, `Definition of done`) present |
| `ambiguous_fail_closed` | Base sections invalid, or only one refinement section present — the resolver does not route the plan forward |

In the CLI, a base-valid plan carrying only one refinement section is reported as `ambiguous_fail_closed` with exit 0 (the operator completes the missing section before refine/promote); a missing/unreadable plan, or one that fails the base-section validator, makes startup exit 1 with no readiness bundle.

### P3 — Local refine + review checkpoint (#951)

`scripts/refine/refine-plan-file.mjs` drives the refine step; the pure contract `@dev-loops/core/loop/plan-file-refine-contract` (`packages/core/src/loop/plan-file-refine-contract.mjs`) exports `refinePlanFileInPlace`, which writes the refiner payload back into the single canonical plan file in place — the `Acceptance criteria` and `Definition of done` sections, a `Size estimate` section (`SIZE_ESTIMATE_HEADING`; see [Size estimate (refinement)](local-planning.md#size-estimate-refinement)), a `Coverage matrix` section (`COVERAGE_MATRIX_HEADING`), and a `Docs-grill findings` section (`DOCS_GRILL_FINDINGS_HEADING`) — then stops at the `local_human_review` checkpoint (`PLAN_FILE_REFINE_STOP.LOCAL_HUMAN_REVIEW`) with the intake state advanced to `plan_refined_ready_for_promotion`. The module performs no GitHub mutation, no network calls, and no filesystem I/O; the caller reads and writes the plan file. The docs-grill runs as a step within refinement: the CLI classifies each finding with `classifyDocsGrillFinding` (`scripts/loop/docs-grill-contract.mjs`) and the contract records the dispositions. See the [Docs-Grill Step](./docs-grill-step.md).

### P4 — Promotion + authority transfer (#952)

`scripts/refine/promote-plan.mjs` promotes a refined plan; the pure contract `@dev-loops/core/loop/plan-file-promote-contract` (`packages/core/src/loop/plan-file-promote-contract.mjs`) exports `evaluatePromoteEligibility` and `buildPromotionPrBody`. Promotion is PR-first: it commits the plan doc and opens exactly one draft PR via the canonical PR wrapper, and mints no GitHub issue. The plan↔PR link is bidirectional — the PR body carries the committed plan-doc path (the spec-of-record) and the plan front-matter carries `prNumber:` (`PLAN_FILE_PR_FRONT_MATTER_KEY`). When present, the plan's `Size estimate` section is carried into the PR body verbatim, so an `oversize: justified` note flows into the same PR the fail-closed post-hoc size budget (`scripts/loop/check-size-budget.mjs`) later escalates. Promotion is idempotent: a plan that already carries `prNumber` resolves to `already_promoted` (`PLAN_FILE_PROMOTE_ACTION.ALREADY_PROMOTED`) and opens nothing. The optional `prNumber` front-matter and its parser/serializer are described in the [Plan-file Contract](local-planning.md#plan-file-contract).

### P5 — Local-first noise profile (#953)

The shipped extension layer pairs local-first with a low-noise posture, in `packages/core/src/config/extension-defaults.yaml`:

| Key | Shipped value | Why |
|---|---|---|
| `strategy` | `local-first` | The shipped default posture (decision #7) |
| `autonomy.humanMergeOnly` | `true` | Local-first never auto-merges; a human always merges |
| `queue.maxAutoFiledIssues` | `1` | Local-first is PR-first, so auto-filing issues is near-zero; a low cap keeps tracker noise minimal |
| `gates.postFindingsComments` | `false` | Gate findings already live on the PR as the round's verdict review; a second consolidated comment would only duplicate them |

`BUILT_IN_DEFAULTS` keeps the tracker-first values (`humanMergeOnly: false`, `maxAutoFiledIssues: 10`); the extension layer sets the local-first values above. A repo `.devloops` can override any of them.

## dev-loops own mode

dev-loops runs **local-planning**: its repo-root `.devloops` sets `strategy: local-first` and `inputSource: tracker`. With `inputSource: tracker`, a local-first session implements from a supplied GitHub issue body (the issue is the spec source for that run); `phase-docs` switches the source to a committed plan file.

## Relationship to other docs

| Doc | Relationship |
|---|---|
| [Public Dev Loop Contract](public-dev-loop-contract.md) | This contract is the canonical entrypoint; artifact authority contract defines the artifact model it assumes |
| [Local Planning](local-planning.md) | Plan-file format (phase-doc format) and required base sections; operator sequence for the local-first flow (validate → start → refine → promote); and a worked example of one plan file evolving through every stage |
| [Spike-mode Contract](spike-mode-contract.md) | Time-boxed exploratory runs; a graduated spike emits a plan file that enters this local-planning tier |
| [Tracker-First Loop State](tracker-first-loop-state.md) | Defines the PR-level state machine for tracker-first PR workflows; that is execution state, separate from artifact authority |
| [Tracker Seam Contract](tracker-seam-contract.md) | Defines the `Tracker` provider interface/registry (issue #1408) — which provider backs "GitHub issue"; orthogonal to this doc's artifact-authority model |
| [Main Agent Contract](main-agent-contract.md) | Defines the delegation boundary; artifact authority defines which artifacts govern work |
| AGENTS.md | Repo constitution; cites the work-origin rule and points to this contract |
| [Dev Loop Skill](../dev-loop/SKILL.md) | Public entrypoint skill; cites the work-origin rule and points to this contract |

"Tracker-first" in `tracker-first-loop-state.md` means tracker-driven PR state transitions (a PR-level workflow contract), a separate concern from this artifact-authority model.

## Non-goals

- The `Tracker` provider interface/registry or multi-tracker support ([Tracker Seam Contract](tracker-seam-contract.md), issue #1408)
- Detailed PR-to-issue mapping ([Public Dev Loop Contract](public-dev-loop-contract.md))
- Changing the dev-loop startup resolver behavior
