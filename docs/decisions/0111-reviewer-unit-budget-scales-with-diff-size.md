# 0111. Reviewer unit budget scales with the reviewed diff size

## Status

Accepted — 2026-09-28 ([issue 2503](https://github.com/mfittko/dev-loops/issues/2503))

Amends [0095](0095-single-wave-gate-fanout.md): it replaces the statement that the `REVIEWER_UNIT_BUDGET` turn and tool-call limits (45 and 50) stay unchanged. The rest of ADR 0095 stands.

## Context

Every scoped reviewer unit had the same budget of 45 model turns and 50 tool calls, whatever the diff size. On PR 2495, a 105-file, 1.37 MB prose diff, the correctness-input reviewer used 53 tool calls and 51 model turns. It found no defects, but the contract required a `blocked` result. Fan-in failed closed with `fanout_evidence_blocked`, and the whole draft_gate round had to be retired and re-run. On small diffs the fixed budget is looser than it needs to be.

## Decision

The emitter `scripts/github/emit-fanout-dispatch.mjs` derives each unit's budget from the size of the diff that unit reviews, at emit time.

The scoped diff is the filtered diff, the required `diff` read of the gate context. For a unit whose angles all declare the `docs-only` scope, only the doc-file blocks (`classifyFile === "docs"`) and the blocks with an unparsed path count. For every other unit, all file blocks count. `files` is the number of file blocks. `changedLines` is the number of added plus deleted lines in those blocks.

`computeReviewerUnitBudget({ files, changedLines })` in `packages/core/src/loop/reviewer-unit-bound.mjs` computes:

- `extra = ceil(0.25 * files + 0.002 * changedLines)`
- `maxToolCalls = min(100, 50 + extra)`
- `maxModelTurns = min(95, 45 + extra)`

The floor (50 tool calls, 45 model turns), the coefficients (0.25 per file, 0.002 per changed line) and the cap (100, 95) are exported constants in that module. `REVIEWER_UNIT_BUDGET` stays exported as the floor. A thin briefing (`scope.diffSource = "none"`) has no diff, so its units get the floor.

The emit plan records each unit's `budget` and its `budgetBasis` (`scope`, `files`, `changedLines`). The dispatch suffix prints the unit's computed numbers. Its blocked-result command carries them as integer literals: `--max-model-turns <n> --max-tool-calls <m>`. `scripts/github/emit-reviewer-blocked.mjs` passes those flags to `enforceReviewerUnitBound` as `budget`. The bound rejects a budget below the floor or above the cap, and uses the floor when none is passed. Each blocked artifact records the budget it was measured against.

Fan-in keeps no numeric budget check. It keeps failing closed on any `blocked` artifact, and ADR 0095's operator stop on a non-zero `reviewer_budget_exhausted` count is unchanged.

## Measurement basis

The coefficients fit measured PRs, with the generated `.claude/skills`, `.claude/agents` and `.claude/commands` blocks excluded:

- PR 2479 (6 files, 150 lines): 52 tool calls, 47 model turns.
- PR 2480 (8 files, 278 lines): 53, 48.
- PR 2496 (28 files, 907 lines): 59, 54.
- PR 2495 (57 files, 5116 lines): 75, 70. Its reviewer used 53 and 51.

PR 2495 without the exclusion (105 files, 9290 lines) gives 95 and 90.

## Consequences

A large diff no longer forces a clean reviewer into a `blocked` result and a full round re-run. A small diff keeps a budget close to the old fixed value. The cap bounds the cost of one unit.

The budget follows whatever the filtered diff drops, including the `gates.reviewDiff.excludeGlobs` paths of ADR 0110.

A docs-only unit is sized on its doc blocks, but its required `diff` read is still the full filtered diff. On a large code-heavy diff with few doc files, that unit keeps a budget near the floor while it reads the whole diff, so it can still end in `reviewer_budget_exhausted`. Scoping the docs-only diff read to doc blocks, or sizing every unit on the full diff, is left to a follow-up.

Rejected alternatives:

- A repo config key for the floor, the coefficients or the cap. One repo and one harness do not justify it yet.
- A numeric budget check in fan-in. Fan-in already fails closed on any `blocked` artifact.
