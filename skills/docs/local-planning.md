# Local planning

Local-planning mode's three surfaces in one document: the [Plan-file Contract](#plan-file-contract)
(the file format), the [Local-Planning Flow](#local-planning-flow) (the operator sequence), and the
[Local-Planning Worked Example](#local-planning-worked-example) (one plan file traced through every
stage). The artifact-selection model that chooses local-planning mode lives in the
[Artifact Authority Contract](artifact-authority-contract.md); this document is scoped to what
happens once that mode is selected.

## Plan-file contract

A plan file is the persisted markdown artifact that drives work in local-planning mode. It reuses the existing phase-doc format under `docs/phases/` (for example, `docs/phases/phase-<n>.md`). This section defines the file format and its required base sections.

### Format

A plan file is a markdown document whose sections are level-2 (`##`) headings. It follows the same shape as the phase docs already committed under `docs/phases/`, which is also the directory that holds plan files.

### Base authoring sections

A plan file carries these base sections when it is authored, before refinement adds acceptance criteria and a definition of done:

| Heading | Purpose |
|---|---|
| `## Status` | The current lifecycle state of the plan (for example, in progress, deferred). |
| `## Objective` | What the plan sets out to achieve. |
| `## In scope` | The bounded work this plan covers. |
| `## Explicit non-goals` | What this plan leaves out. |

Each base section has a non-empty body. Refinement is a later phase that adds acceptance criteria, a definition of done, and a per-phase size estimate; those are outside the base authoring contract this section defines.

### Size estimate (refinement)

Refinement (`scripts/refine/refine-plan-file.mjs`, `refinePlanFileInPlace` in `@dev-loops/core/loop/plan-file-refine-contract`) also writes a `## Size estimate` section, using the same vocabulary and thresholds as the fail-closed PR size budget (`scripts/loop/check-size-budget.mjs`): `logicLoc`, `tier` (`default`|`t1`|`t3`), and the default tier's `softLoc` escalation threshold. The refiner supplies `payload.sizeEstimate = { logicLoc, tier?, oversizeJustification? }`; `validatePhaseSizeEstimate` checks it against `sizeSoftLoc` (threaded from `gates.size.tiers.default.softLoc`, falling back to `check-size-budget.mjs`'s own default).

An estimate at or under the threshold needs no justification. An estimate over the threshold must carry a non-empty `oversizeJustification` — the refiner looked for a seam to split the phase and, finding none, records why the phase is cohesive — or the refine fails closed (`size_estimate_oversize_not_justified`), prompting that seam search before the plan advances. Splitting stays the cheapest option before generation, but it is never mandatory: a cohesive over-budget phase proceeds with an `oversize: justified` note.

`scripts/refine/promote-plan.mjs` carries the `## Size estimate` section verbatim into the promoted PR's body when present, so the plan-time justification flows into the same PR the post-hoc size budget later escalates.

### Validator

`scripts/refine/validate-plan-file.mjs` checks a plan file against the base sections above. It exports a pure function `validatePlanFile(markdownText)` that returns `{ checker: "validate-plan-file", ok, errors }`, where each absent or empty-body base section contributes one entry with a distinct `missing_*` code. `ok` is `true` when every base section is present with a non-empty body.

The thin CLI accepts `--input <path>`, `--json`, and `--help`. The validation verdict is reported in the JSON payload; the process exits non-zero for argument or path errors (house style — see the [Validation Policy](validation-policy.md)).

### Optional front-matter (plan↔PR link)

A plan file may carry an optional leading YAML front-matter block — a `---` line, `key: value` lines, a closing `---` line — before its first heading. It is additive: a plan without front-matter is unchanged and fully valid. The only key the tooling reads or writes today is `prNumber:`, the number of the draft PR a plan was promoted into (PR-FIRST promotion never mints an issue; the committed plan doc is the spec-of-record and the PR body links it). The link is recorded bidirectionally — the PR body references the committed plan-doc path; the plan's `prNumber` front-matter references the PR. Promotion (`scripts/refine/promote-plan.mjs`) writes `prNumber` and is idempotent on a plan that already carries one. The parser/serializer lives in the pure `@dev-loops/core/loop/plan-file-promote-contract` module.

## Local-planning flow

The operator sequence for the local-first plan-file flow. The [Artifact Authority Contract](artifact-authority-contract.md) owns the model and the per-phase contract details; this section names the shipped helper scripts in the order they run for one plan file. The [Local-Planning Worked Example](#local-planning-worked-example) below shows a single plan file evolving through these steps.

The flow applies under local-planning mode (`strategy: local-first`, the shipped default — see the contract's [Shipped default posture](artifact-authority-contract.md#shipped-default-posture)). The plan file lives under `docs/phases/`.

### Stages

| Stage | Helper script | Pure logic |
|---|---|---|
| Validate | `scripts/refine/validate-plan-file.mjs` | `validatePlanFile` (in the helper script; not a `@dev-loops/core` export) |
| Start | `scripts/loop/resolve-dev-loop-startup.mjs --plan-file <path>` | `evaluatePlanFileIntakeState` (`@dev-loops/core/loop/plan-file-intake-contract`) |
| Refine | `scripts/refine/refine-plan-file.mjs` | `refinePlanFileInPlace` (`@dev-loops/core/loop/plan-file-refine-contract`) |
| Promote | `scripts/refine/promote-plan.mjs` | `evaluatePromoteEligibility` / `buildPromotionPrBody` (`@dev-loops/core/loop/plan-file-promote-contract`) |

### 1. Author and validate the plan

Author a phase-doc-format plan under `docs/phases/` with the four base sections `## Status`, `## Objective`, `## In scope`, `## Explicit non-goals`. Check it against the base-section contract:

```
node scripts/refine/validate-plan-file.mjs --input docs/phases/phase-<n>.md --json
```

The JSON payload reports `{ checker: "validate-plan-file", ok, errors }`. Each absent or empty-body base section contributes one entry with a distinct `missing_*` code; `ok` is `true` when every base section is present with a non-empty body.

### 2. Start the local-planning session

Hand the plan to startup with `--plan-file` (mutually exclusive with `--issue`, `--pr`, and `--input`):

```
node scripts/loop/resolve-dev-loop-startup.mjs --plan-file docs/phases/phase-<n>.md
```

Startup validates the plan and threads an intake state onto its output. A plan with valid base sections and no refinement sections is `new_plan_needs_refinement`; the same plan once it also carries `Acceptance criteria` and `Definition of done` is `plan_refined_ready_for_promotion`. A base-valid plan that carries only one of the two refinement sections is reported as `ambiguous_fail_closed` with exit 0 and is not routed forward — the operator completes the missing section first. A plan that is missing/unreadable or fails the base validator makes startup fail closed (exit 1, no readiness bundle).

### 3. Refine in place and stop at the local human-review checkpoint

The refine step writes the refiner output back into the same plan file:

```
node scripts/refine/refine-plan-file.mjs --plan-file docs/phases/phase-<n>.md --payload <payload.json>
```

`refinePlanFileInPlace` appends the `Acceptance criteria`, `Definition of done`, `Size estimate`, `Coverage matrix`, and `Docs-grill findings` sections, then advances the intake state to `plan_refined_ready_for_promotion` and stops at the `local_human_review` checkpoint. The docs-grill runs as a step within refinement: each finding is classified with `classifyDocsGrillFinding` (see the [Docs-Grill Step](./docs-grill-step.md)) and the dispositions are recorded into the plan. The `Size estimate` section carries a per-phase `logicLoc`/`tier` estimate against the same threshold `check-size-budget.mjs` escalates on; an over-threshold estimate needs a non-empty `oversizeJustification` in the payload or the refine fails closed (see [Size estimate (refinement)](#size-estimate-refinement) above). The step makes no GitHub or network call; the human reviews the refined plan before anything is promoted.

### 4. Promote to a single draft PR

Once the human approves the refined plan, promote it:

```
node scripts/refine/promote-plan.mjs --plan-file docs/phases/phase-<n>.md
```

Promotion is PR-first: it commits the plan doc and opens exactly one draft PR via the canonical PR wrapper, and mints no GitHub issue. It records the plan↔PR link bidirectionally — the PR body references the committed plan-doc path, and the plan's front-matter gains a `prNumber:` entry. When the plan carries a `Size estimate` section, its full body (including an `oversize: justified` note) is carried into the PR body verbatim, so a plan-time size justification flows into the same PR the post-hoc `gates.size` budget later escalates. The committed plan doc is the spec-of-record; the draft PR enters the standard draft → pre-approval → human-merge flow. Promotion is idempotent: re-running on a plan that already carries `prNumber` resolves to `already_promoted` and opens nothing.

## Local-planning worked example

One plan file, `docs/phases/phase-42.md`, carried through every stage of the [Local-Planning Flow](#local-planning-flow) above: authored, validated, refined in place, held at the local human-review checkpoint, then promoted to a draft PR. Each stage below shows the same file's content as it evolves. The contract details live in the [Artifact Authority Contract](artifact-authority-contract.md); this is a concrete trace of one file.

The repo runs local-planning by default (`strategy: local-first`), and the plan lives under `docs/phases/`.

### Stage 1 — Authored

The operator writes the four base sections. The file at this point:

```markdown
# phase-42 plan

## Status

draft

## Objective

Add a `--dry-run` flag to the queue dispatcher so an operator can preview the
dispatch order without mutating the board.

## In scope

- Parse `--dry-run` in the queue dispatcher CLI.
- Print the resolved dispatch order and exit 0 without any board mutation.

## Explicit non-goals

- Changing the dispatch ordering algorithm.
- Any change to non-dry-run dispatch behavior.
```

Validation passes:

```
$ node scripts/refine/validate-plan-file.mjs --input docs/phases/phase-42.md --json
{ "checker": "validate-plan-file", "ok": true, "errors": [] }
```

### Stage 2 — Started (intake state)

Startup reads the plan and reports the intake state. With the four base sections present and no refinement sections yet, the state is `new_plan_needs_refinement`:

```
$ node scripts/loop/resolve-dev-loop-startup.mjs --plan-file docs/phases/phase-42.md
# ... startup output carries planFileIntakeState: "new_plan_needs_refinement"
```

### Stage 3 — Refined in place

`refine-plan-file.mjs` appends the refinement sections, the per-phase size estimate, the coverage matrix, and the recorded docs-grill findings to the same file, then stops at the `local_human_review` checkpoint. The file now reads (added sections shown):

```markdown
# phase-42 plan

## Status

draft

## Objective

Add a `--dry-run` flag to the queue dispatcher so an operator can preview the
dispatch order without mutating the board.

## In scope

- Parse `--dry-run` in the queue dispatcher CLI.
- Print the resolved dispatch order and exit 0 without any board mutation.

## Explicit non-goals

- Changing the dispatch ordering algorithm.
- Any change to non-dry-run dispatch behavior.

## Acceptance criteria

- `--dry-run` prints the resolved dispatch order to stdout.
- `--dry-run` performs zero board mutation (no Projects V2 writes).
- Exit code is 0 on a successful dry-run preview.

## Definition of done

- CLI parses `--dry-run`; unit test covers the parse path.
- A test asserts no board-mutation call fires under `--dry-run`.
- The queue docs note the flag.

## Size estimate

- Estimated logic LOC: 90
- Tier: default
- Oversize: n/a (within default tier's softLoc budget of 400)

## Coverage matrix

| Item | Type | Status | Evidence | Notes |
|---|---|---|---|---|
| `--dry-run` prints dispatch order | AC | Unverified | pending implementation | |
| `--dry-run` performs zero mutation | AC | Unverified | pending implementation | |
| Exit code 0 on preview | AC | Unverified | pending implementation | |
| No-mutation test | DoD | Unverified | pending test | |
| Dispatch algorithm unchanged | Non-goal | Unverified | scope boundary | |

## Docs-grill findings

- [fix_in_place] (stale_reference) Queue docs example omits the new flag; add it on this branch.
```

The intake state for this file is now `plan_refined_ready_for_promotion`. The loop stops here for the operator to review the refined plan before promotion.

### Stage 4 — Local human-review checkpoint

The operator reads the refined plan, confirms the acceptance criteria and coverage matrix, and dispositions the docs-grill findings. No GitHub mutation has happened so far; the plan file is the only artifact. When the operator approves, the flow moves to promotion.

### Stage 5 — Promoted to a draft PR

`promote-plan.mjs` commits the plan doc, opens one draft PR, and writes the PR number back into the plan's front-matter. The file gains a leading front-matter block (the body is unchanged):

```markdown
---
prNumber: 1234
---
# phase-42 plan

## Status

draft

## Objective

Add a `--dry-run` flag to the queue dispatcher so an operator can preview the
dispatch order without mutating the board.

# ... base, refinement, coverage-matrix, and docs-grill sections unchanged ...
```

The PR body references `docs/phases/phase-42.md` as the spec-of-record, completing the bidirectional plan↔PR link, and carries the plan's `Size estimate` section verbatim (here, under budget — an over-budget phase's `oversize: justified` note would flow through the same way). No GitHub issue was minted. Re-running `promote-plan.mjs` on this file now resolves to `already_promoted` and opens nothing, because the front-matter already carries `prNumber`.

## Relationship to other docs

| Doc | Relationship |
|---|---|
| [Artifact Authority Contract](artifact-authority-contract.md) | Canonical model that selects local-planning mode; owns the per-phase contract details this document's plan-file format, flow, and worked example implement. |
| [Validation Policy](validation-policy.md) | Owns the shared CLI verdict-versus-exit-code convention the plan-file validator follows. |
| [Docs-Grill Step](./docs-grill-step.md) | The in-loop grill that runs as a step within refinement. |
