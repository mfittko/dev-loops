# Plan-file contract

A plan file is the persisted markdown artifact that drives work in local-planning mode. It reuses the existing phase-doc format under `docs/phases/` (for example, `docs/phases/phase-<n>.md`). The artifact authority model that selects local-planning mode lives in the [Artifact Authority Contract](artifact-authority-contract.md); this document defines the file format and its required base sections.

## Format

A plan file is a markdown document whose sections are level-2 (`##`) headings. It follows the same shape as the phase docs already committed under `docs/phases/`. The directory that holds plan files is `localPlanning.plansDir`, which defaults to `docs/phases/`.

## Base authoring sections

A plan file carries these base sections when it is authored, before refinement adds acceptance criteria and a definition of done:

| Heading | Purpose |
|---|---|
| `## Status` | The current lifecycle state of the plan (for example, in progress, deferred). |
| `## Objective` | What the plan sets out to achieve. |
| `## In scope` | The bounded work this plan covers. |
| `## Explicit non-goals` | What this plan leaves out. |

Each base section has a non-empty body. Refinement is a later phase that adds acceptance criteria and a definition of done; those are outside the base authoring contract this document defines.

## Validator

`scripts/refine/validate-plan-file.mjs` checks a plan file against the base sections above. It exports a pure function `validatePlanFile(markdownText)` that returns `{ checker: "validate-plan-file", ok, errors }`, where each absent or empty-body base section contributes one entry with a distinct `missing_*` code. `ok` is `true` when every base section is present with a non-empty body.

The thin CLI accepts `--input <path>`, `--json`, and `--help`. The validation verdict is reported in the JSON payload; the process exits non-zero for argument or path errors (house style — see the [Validation Policy](validation-policy.md)).

## Optional front-matter (plan↔PR link)

A plan file may carry an optional leading YAML front-matter block — a `---` line, `key: value` lines, a closing `---` line — before its first heading. It is additive: a plan without front-matter is unchanged and fully valid. The only key the tooling reads or writes today is `prNumber:`, the number of the draft PR a plan was promoted into (PR-FIRST promotion never mints an issue; the committed plan doc is the spec-of-record and the PR body links it). The link is recorded bidirectionally — the PR body references the committed plan-doc path; the plan's `prNumber` front-matter references the PR. Promotion (`scripts/refine/promote-plan.mjs`) writes `prNumber` and is idempotent on a plan that already carries one. The parser/serializer lives in the pure `@dev-loops/core/loop/plan-file-promote-contract` module.

## Relationship to other docs

| Doc | Relationship |
|---|---|
| [Artifact Authority Contract](artifact-authority-contract.md) | Owns the artifact-selection model; selects local-planning mode and points here for the plan-file format. |
| [Validation Policy](validation-policy.md) | Owns the shared CLI verdict-versus-exit-code convention this validator follows. |
