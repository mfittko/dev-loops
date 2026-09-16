# Skills prose cleanup coverage

Tracking issue: [2236](https://github.com/mfittko/dev-loops/issues/2236). Baseline: `894a5a59080222cef5a47fc3f4e962824e05bfda`.

Inventory: 77 tracked files under `skills/`, including 67 Markdown files and ten code/registry files. A pending row is not reviewed coverage. This record tracks execution; the issue remains the canonical specification.

Dispositions: `pending`, `in progress`, `changed`, `unchanged`, `generated`, `non-prose`, `blocked`. Generated `.claude/skills/` projections are outside this source inventory and must be regenerated, never edited by hand. Script/registry rows remain pending until their prose-bearing parts have been inspected; no code/schema rewrite is authorized.

Phases: 1 = Copilot follow-up and directly coupled references/tests; 2 = other routed entrypoints and their workflow contracts; 3 = remaining shared documentation, references, templates and script comments/help. Only phase 1 is active. All phases use the same cleanup PR unless the human changes the scope.

## File inventory

| File | Phase | Disposition | Evidence / remaining work |
| --- | --- | --- | --- |
| `skills/copilot-pr-followup/SKILL.md` | 1 | in progress | Path-resolution prose simplified and independently reviewed; remaining sections pending, including recorded ambiguities. |
| `skills/dev-loop/SKILL.md` | 2 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/dev-mode-context.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/dev-mode-context.test.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/init-phase.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/log-bash-exit-1.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/phase-files.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.test.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/render-template.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/scripts/render-template.test.mjs` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/bootstrap-agents.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/bootstrap-implementation-state.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/bootstrap-implementation-workflow.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/dev-mode-retrospective.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/dev-mode-review.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/dev-mode-skill-changes.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/merged-phase-plan.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/phase-doc.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/phase-summary.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/phase-variant.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/retrospective.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/review.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/slides-story-review.md` | 3 | pending | Not yet reviewed. |
| `skills/dev-loop/templates/ui-vision-review.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ab-contrast-deslop-step.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/acceptance-criteria-verification.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/agent-stall-detection.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/anti-patterns.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/artifact-authority-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/conductor-routing-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/confirmation-rules.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/contract-style-guide.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/copilot-ci-status-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/copilot-loop-operations.md` | 1 | in progress | Source and coupled contracts under inspection. |
| `skills/docs/copilot-loop-state-graph.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/cross-harness-regression-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/decision-record-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/docs-grill-step.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/entrypoint-strategies.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/epic-tree-refinement-procedure.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/gate-review-comment-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/gate-review-sub-loop-contract.md` | 1 | in progress | Source and coupled contracts under inspection. |
| `skills/docs/issue-intake-procedure.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/local-planning.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/main-agent-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/merge-preconditions.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/pr-lifecycle-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/projects-queue-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/public-dev-loop-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/release-runbook.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/required-rules.json` | 3 | pending | Not yet reviewed. |
| `skills/docs/retrospective-checkpoint-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/reviewer-loop-state-graph.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/slides-story-review-loop.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/spec-authority-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/spike-mode-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/stop-conditions.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/structural-quality.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/sub-issue-tree-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/tracker-first-loop-state.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/tracker-seam-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-artifact-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-designer-review-loop.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-e2e-scoping-step.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-review-recipe-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-smoke-harness.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/ui-validation-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/validation-policy.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/wait-watch-procedure.md` | 1 | in progress | Opener, read-only boundary and timeout wording simplified and independently reviewed; remaining sections pending. |
| `skills/docs/workflow-handoff-contract.md` | 3 | pending | Not yet reviewed. |
| `skills/docs/worktree-guidance.md` | 3 | pending | Not yet reviewed. |
| `skills/final-approval/SKILL.md` | 2 | pending | Not yet reviewed. |
| `skills/local-implementation/SKILL.md` | 2 | pending | Not yet reviewed. |
| `skills/loop-grill/SKILL.md` | 2 | pending | Not yet reviewed. |
| `skills/review/SKILL.md` | 2 | pending | Not yet reviewed. |
| `skills/ui-review/SKILL.md` | 2 | pending | Not yet reviewed. |

## Phase 1 validation plan

Reviewed first slice: simplify the follow-up skill's startup/path-resolution prose and the shared wait procedure; replace generated-projection prose pins using existing transformation tests. Keep fan-out/fan-in and other ambiguous instructions unchanged until their conflicts are resolved. Variant A (selected) makes local edits without moving anchors or rules. Variant B would extract more procedures into new references, but increases packaging and point-of-use risks without evidence that new files are needed.

Compare old/new instructions for actors, permissions, triggers, conditions, order, exceptions, stop rules, evidence and revision identity. Preserve frontmatter, rule IDs, command examples and the declared verbatim dispatch payload. Independently evaluate high-risk scenarios with no live writes. Replace incidental prose pins with existing structural/behavior seams; keep exact API/projection checks. Run docs, contract, generated-asset and default verification before draft handoff.

## Open ambiguities

- Fan-in count: source mentions `fanout.pendingGroups.length`, but the emitter can split leftover groups into additional reviewer units. Trace actual emitted/spawned-unit authority before editing.
- CI evidence flag: follow-up describes `--local-validation-head-sha`; the wait procedure says the detector CLI removed it. Verify the supported interface before changing instructions.

The detector's current `--help` lists no `--local-validation-head-sha` option. The dispatch emitter returns its expanded unit count, and its tests cover splits beyond the configured group count. These are evidence for reconciliation, not permission to silently redefine behavior. No semantic resolution or clean whole-phase verdict is recorded yet.

## First-slice evidence

- Independent old/new review read both complete edited sources and found no material semantic regression.
- Read-only scenarios covered stale installed source, older installed tooling, dirty PR/new-review transitions, exhausted review budget, Pi versus Claude continuation, and invalid startup/envelope. All preserved the required decisions. This is scoped scenario evidence, not lifecycle-gate clearance or proof of universal semantics.
- `test/contracts/claude-assets-reproducible.test.mjs` now checks paired Pi-only markers, source-derived omission, complete projection equality and the actual wait-route target. Existing transform fixtures assert exact outputs while varying prose wording and wrapping. API literals and generated byte parity remain checked.
- Tests do not prove that arbitrary text inside a valid scope marker has the right meaning. Source semantic review and the scenarios above cover that limitation for this slice.
- The source edits retain frontmatter, rule IDs, command blocks, anchors and the declared verbatim dispatch payload. Generated Claude copies come from the canonical generator.
- Remaining brittle tests include the Copilot review persistence/section pins, issue-intake persistence pins, carry-forward single-line extraction and defect-surfacing prose assertions. These remain in the same cleanup scope, not silently declared fixed.

The first slice changes two source documents; neither is fully reviewed for simplification yet. All other inventory rows remain pending or under inspection. Do not merge this partial cleanup as completion of issue 2236.

Validation for this slice used Bun 1.4.1: 69 focused contract/projection tests passed; generated-asset check passed for 92 assets; docs/link/rule/changelog checks passed. The first default `bun run verify` attempt exposed another incidental packaging-sentence assertion and local listener/Git worktree fixture failures. The assertion was replaced with installed-link, bundle, packaging and ownership checks; all 12 tests in that file passed, including wording variants and missing-link/bundle failures. The two environmental test files passed all 48 tests with the required local permissions. A full rerun on `49125139` then passed: 9,289 tests across 390 files, zero skipped or failed, plus docs and workflow checks. This is local validation, not lifecycle-gate clearance or completion of the remaining inventory.
