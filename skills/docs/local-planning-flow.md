# Local-planning flow

The operator sequence for the local-first plan-file flow. The [Artifact Authority Contract](artifact-authority-contract.md) owns the model and the per-phase contract details; this doc names the shipped helper scripts in the order they run for one plan file. The [Local-Planning Worked Example](local-planning-worked-example.md) shows a single plan file evolving through these steps.

The flow applies under local-planning mode (`strategy: local-first`, the shipped default — see the contract's [Shipped default posture](artifact-authority-contract.md#shipped-default-posture)). The plan file lives under `docs/phases/`.

## Stages

| Stage | Helper script | Pure logic |
|---|---|---|
| Validate | `scripts/refine/validate-plan-file.mjs` | `validatePlanFile` (in the helper script; not a `@dev-loops/core` export) |
| Start | `scripts/loop/resolve-dev-loop-startup.mjs --plan-file <path>` | `evaluatePlanFileIntakeState` (`@dev-loops/core/loop/plan-file-intake-contract`) |
| Refine | `scripts/refine/refine-plan-file.mjs` | `refinePlanFileInPlace` (`@dev-loops/core/loop/plan-file-refine-contract`) |
| Promote | `scripts/refine/promote-plan.mjs` | `evaluatePromoteEligibility` / `buildPromotionPrBody` (`@dev-loops/core/loop/plan-file-promote-contract`) |

## 1. Author and validate the plan

Author a phase-doc-format plan under `docs/phases/` with the four base sections `## Status`, `## Objective`, `## In scope`, `## Explicit non-goals`. Check it against the base-section contract:

```
node scripts/refine/validate-plan-file.mjs --input docs/phases/phase-<n>.md --json
```

The JSON payload reports `{ checker: "validate-plan-file", ok, errors }`. Each absent or empty-body base section contributes one entry with a distinct `missing_*` code; `ok` is `true` when every base section is present with a non-empty body.

## 2. Start the local-planning session

Hand the plan to startup with `--plan-file` (mutually exclusive with `--issue`, `--pr`, and `--input`):

```
node scripts/loop/resolve-dev-loop-startup.mjs --plan-file docs/phases/phase-<n>.md
```

Startup validates the plan and threads an intake state onto its output. A plan with valid base sections and no refinement sections is `new_plan_needs_refinement`; the same plan once it also carries `Acceptance criteria` and `Definition of done` is `plan_refined_ready_for_promotion`. A base-valid plan that carries only one of the two refinement sections is reported as `ambiguous_fail_closed` with exit 0 and is not routed forward — the operator completes the missing section first. A plan that is missing/unreadable or fails the base validator makes startup fail closed (exit 1, no readiness bundle).

## 3. Refine in place and stop at the local human-review checkpoint

The refine step writes the refiner output back into the same plan file:

```
node scripts/refine/refine-plan-file.mjs --plan-file docs/phases/phase-<n>.md --payload <payload.json>
```

`refinePlanFileInPlace` appends the `Acceptance criteria` and `Definition of done` sections, a `Coverage matrix` section, and a `Docs-grill findings` section, then advances the intake state to `plan_refined_ready_for_promotion` and stops at the `local_human_review` checkpoint. The docs-grill runs as a step within refinement: each finding is classified with `classifyDocsGrillFinding` (see the [Docs-Grill Step](./docs-grill-step.md)) and the dispositions are recorded into the plan. The step makes no GitHub or network call; the human reviews the refined plan before anything is promoted.

## 4. Promote to a single draft PR

Once the human approves the refined plan, promote it:

```
node scripts/refine/promote-plan.mjs --plan-file docs/phases/phase-<n>.md
```

Promotion is PR-first: it commits the plan doc and opens exactly one draft PR via the canonical PR wrapper, and mints no GitHub issue. It records the plan↔PR link bidirectionally — the PR body references the committed plan-doc path, and the plan's front-matter gains a `prNumber:` entry. The committed plan doc is the spec-of-record; the draft PR enters the standard draft → pre-approval → human-merge flow. Promotion is idempotent: re-running on a plan that already carries `prNumber` resolves to `already_promoted` and opens nothing.

## Relationship to other docs

| Doc | Relationship |
|---|---|
| [Artifact Authority Contract](artifact-authority-contract.md) | Canonical model and per-phase contract details for the local-first flow |
| [Plan-file Contract](plan-file-contract.md) | Plan-file format, base sections, validator, and the optional `prNumber` front-matter |
| [Local-Planning Worked Example](local-planning-worked-example.md) | One plan file shown through every stage of this sequence |
| [Docs-Grill Step](./docs-grill-step.md) | The in-loop grill that runs as a step within refinement |
