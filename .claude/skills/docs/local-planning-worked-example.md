# Local-planning worked example

One plan file, `docs/phases/phase-42.md`, carried through every stage of the [Local-Planning Flow](local-planning-flow.md): authored, validated, refined in place, held at the local human-review checkpoint, then promoted to a draft PR. Each stage below shows the same file's content as it evolves. The contract details live in the [Artifact Authority Contract](artifact-authority-contract.md); this is a concrete trace of one file.

The repo runs local-planning by default (`strategy.default: local-first`), and the plan lives under `localPlanning.plansDir` (`docs/phases/`).

## Stage 1 — Authored

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

## Stage 2 — Started (intake state)

Startup reads the plan and reports the intake state. With the four base sections present and no refinement sections yet, the state is `new_plan_needs_refinement`:

```
$ node scripts/loop/resolve-dev-loop-startup.mjs --plan-file docs/phases/phase-42.md
# ... startup output carries planFileIntakeState: "new_plan_needs_refinement"
```

## Stage 3 — Refined in place

`refine-plan-file.mjs` appends the refinement sections, the coverage matrix, and the recorded docs-grill findings to the same file, then stops at the `local_human_review` checkpoint. The file now reads (added sections shown):

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

## Stage 4 — Local human-review checkpoint

The operator reads the refined plan, confirms the acceptance criteria and coverage matrix, and dispositions the docs-grill findings. No GitHub mutation has happened so far; the plan file is the only artifact. When the operator approves, the flow moves to promotion.

## Stage 5 — Promoted to a draft PR

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

The PR body references `docs/phases/phase-42.md` as the spec-of-record, completing the bidirectional plan↔PR link. No GitHub issue was minted. Re-running `promote-plan.mjs` on this file now resolves to `already_promoted` and opens nothing, because the front-matter already carries `prNumber`.

## Relationship to other docs

| Doc | Relationship |
|---|---|
| [Local-Planning Flow](local-planning-flow.md) | The operator sequence this example traces |
| [Artifact Authority Contract](artifact-authority-contract.md) | Canonical model and per-phase contract details |
| [Plan-file Contract](plan-file-contract.md) | Plan-file format, base sections, and the `prNumber` front-matter |
