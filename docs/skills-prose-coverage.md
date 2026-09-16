# Skills prose cleanup coverage

Tracking issue: [2236](https://github.com/mfittko/dev-loops/issues/2236). Baseline: `894a5a59080222cef5a47fc3f4e962824e05bfda`.

Inventory: 77 tracked files under `skills/`, including 67 Markdown files and ten code/registry files. A pending row is not reviewed coverage. This record tracks execution; the issue remains the canonical specification.

Dispositions: `pending`, `in progress`, `changed`, `unchanged`, `generated`, `non-prose`, `blocked`. Generated `.claude/skills/` projections are outside this source inventory and must be regenerated, never edited by hand. Script/registry rows remain pending until their prose-bearing parts have been inspected; no code/schema rewrite is authorized.

Phases: 1 = Copilot follow-up and directly coupled references/tests; 2 = other routed entrypoints and their workflow contracts; 3 = remaining shared documentation, references, templates and script comments/help. Only phase 1 is active. All phases use the same cleanup PR unless the human changes the scope.

## File inventory

| File | Phase | Disposition | Evidence / remaining work |
| --- | --- | --- | --- |
| `skills/copilot-pr-followup/SKILL.md` | 1 | in progress | Path-resolution and fan-out/fan-in checklist condensed; mandatory owner loading explicit. Remaining sections and recorded ambiguities pending. |
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
| `skills/docs/gate-review-sub-loop-contract.md` | 1 | in progress | Full source read; primer, grouping duplication and fan-in count explanation condensed. Independent semantic/scenario review passed for this slice; remaining sections pending. |
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

Reviewed first slice: simplify the follow-up skill's startup/path-resolution prose and the shared wait procedure; replace generated-projection prose pins using existing transformation tests. Subsequent slices condense fan-out/fan-in with its owner while preserving unresolved conflicting instructions. This PR is variant A; the issue now defines an independent variant-B comparison. Neither variant is selected for merge.

Compare old/new instructions for actors, permissions, triggers, conditions, order, exceptions, stop rules, evidence and revision identity. Preserve frontmatter, rule IDs, command examples and the declared verbatim dispatch payload. Independently evaluate high-risk scenarios with no live writes. Replace incidental prose pins with existing structural/behavior seams; keep exact API/projection checks. Run docs, contract, generated-asset and default verification before draft handoff.

## Open ambiguities

- Fan-in count: source mentions `fanout.pendingGroups.length`, but the emitter can split leftover groups into additional reviewer units. Trace actual emitted/spawned-unit authority before editing.
- CI evidence flag: follow-up describes `--local-validation-head-sha`; the wait procedure says the detector CLI removed it. Verify the supported interface before changing instructions.
- Carry eligibility: the skill still says clean-only; the owner and current tools support carrying `findings_present` with unchanged findings. The contradictory passages remain unresolved.
- Zero-unit rounds: the skill says an all-carried round dispatches no emitter, but sanctioned consumers require an emit plan and the emitter/writer reject an empty plan. No exception or new stop rule was invented.

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

## Substantive condensation slice

The human clarified that total loaded contract surface, rather than shorter entrypoints alone, is the objective. Variant A remains PR2237; the independent-B handoff in issue2236 is not a dispatch or merge authorization. This slice follows that clarified spec and does not reuse previous clearance.

The fan-out and fan-in checklist items shrink from 918 words each to 164 and 201 words. Their owner also shrinks: grouping algorithms, primer rationale and count derivations no longer repeat. The skill explicitly requires the complete owner before execution. Existing rule IDs, anchors, flags, evidence duties and harness distinctions remain. The actual emitted/spawned dispatch count replaces the stale unsplit-count derivation, following the owner's existing explicit authority and emitter tests; the other ambiguities above remain untouched.

Measurements use `wc -w -c`: whitespace words and UTF-8 bytes, including code examples/frontmatter, not tokenizer estimates or isolated prose estimates. Columns compare the original unmodified base, the prior A checkpoint, and this slice respectively.

| Named surface | Original base `894a5a59` words / bytes | A checkpoint `cc032f92` words / bytes | This slice words / bytes |
| --- | --- | --- | --- |
| All 77 tracked `skills/` files (including code/registry files) | 152,637 / 1,182,913 | 152,462 / 1,181,751 | 149,162 / 1,157,388 |
| Follow-up skill + gate-review owner | 43,100 / 326,906 | 42,939 / 325,850 | 39,639 / 301,487 |
| Corresponding Claude projections, used instead of source pair | 42,907 / 325,900 | 42,746 / 324,844 | 39,446 / 300,481 |
| Named conductor contract-read set below | 79,828 / 606,829 | 79,667 / 605,773 | 76,367 / 581,410 |

The conductor set assumes a source/Pi follow-up gate and counts each of these full files once: the source pair above; AGENTS.md; dev-loop/SKILL.md; and docs/public-dev-loop-contract, retrospective-checkpoint-contract, copilot-loop-operations, entrypoint-strategies, confirmation-rules, stop-conditions, validation-policy, main-agent-contract, anti-patterns, worktree-guidance, structural-quality, gate-review-comment-contract, spec-authority-contract, acceptance-criteria-verification and merge-preconditions (all docs names under `skills/`, with `.md`). This includes the same mandatory owner in both versions, not a short checklist compared with missing references. It is a named contract-text measurement, not a complete live prompt or token bill: PR/spec/diff artifacts, system instructions and step-specific additional reads vary. Reviewers consume their emitted briefing and role instructions in separate contexts; do not multiply the conductor set by reviewer count. Other routes and a complete transitive live-read audit remain pending.

The compact old-obligation trace is in the local phase review artifact `tmp/phases/issue-2236/condensation-obligations.md`. Independent comparison found no introduced semantic defect; seven read-only scenarios covered emitted groups/leftovers, partial carry, zero-unit ambiguity, missing evidence, opaque caching, grouped provenance and stale head. This is scoped evidence, not lifecycle clearance or proof of better determinism. Contract tests now accept wrapped steps while rejecting flags borrowed from sibling steps. Full verification for this slice passed under Bun1.4.1: 9,290 tests across390 files, no skips/failures, plus docs/workflows. Assets check passed92 projections; docs were rerun after this ledger update.

## Reviewer-budget slice

The next slice condenses the owner's preflight instructions into inputs, result branches and resume duties. It removes another 210 words / 1,467 bytes from both source and corresponding projection, without adding a reference. The source pair is now 39,429 words / 300,020 bytes; the same named conductor set is 76,157 / 579,943. These retain the measurement assumptions above.

Independent old/new review found no changed obligation. Its trace locates budget pass-through and preflight consumption in the opening paragraph, zero dispatch and resumable evidence in the branch table, same-head scanning versus proven prior-head carry in the resume paragraph, ALL-angle exclusion immediately after it, and no verdict/inline exemption in the final paragraph. Six read-only scenarios covered unexposed budget, proven shortfall, clean same-head resume, mixed completed/carried groups, prior-head provenance and zero required reviewers. The unresolved clean-head wording remains unchanged. Generated Claude output was rebuilt; 21 focused tests and 92-asset parity passed. Full `bun run verify` passed under Bun 1.4.1: 9,290 tests across 390 files, zero skips/failures, plus docs/workflows. Whole-phase and lifecycle clearance remain pending.

Inspection for the next slice found an additional existing mismatch in the unchanged render-budget section: unconditional foreign-angle refusal versus the implemented `gates.rejectForeignAngles: false` warning mode. The section also calls no-mandatory-angle gates unaffected, although supplied provenance still receives pool checks. These statements require reconciliation; this slice does not change them or expand acceptance.

## Render-budget slice

Only the unambiguous render/output instructions are condensed; the disputed coverage paragraphs remain unchanged. This removes 258 words / 1,661 bytes from source and its regenerated projection. The source pair is now 39,171 words / 298,359 bytes; the named conductor set is 75,899 / 578,282 under the same read assumptions.

Independent review traced renderer-based fit, the 16-character floor, real finding/angle/verdict retention and complete ledger to the opening paragraph/table; withholding versus refusal and stale-output removal to the table; output existence, summary fallback and severity-count duties to the caller paragraph and unchanged downstream count contract. Four scenarios covered truncation that fits, withholding with a ledger, refusal without a ledger and posting a withheld clean verdict. Removing the assertion that renderer acceptance prevents every later posting failure removes an overstated implementation guarantee, not a permission or duty; posting validation still applies. All 172 fan-in tests and 92-asset parity passed. Full `bun run verify` passed: 9,290 tests across 390 files, no skips/failures, plus docs/workflows. This is not phase completion or lifecycle clearance.

Independent read-set audit adds five applicable owners to the earlier named 19-file set: `workflow-handoff-contract.md`, `artifact-authority-contract.md`, `contract-style-guide.md`, `copilot-loop-state-graph.md` and `pr-lifecycle-contract.md`, all under `skills/docs/`. The resulting 24-file conservative contract surface is 89,563 words / 683,005 bytes at the original base versus 85,634 / 654,458 now (3,929 words / 28,547 bytes removed). Assumption: source/Pi conductor, existing tracker-backed draft PR, first full fan-out round, clean result through ready-for-review; no intake, fix, watch reroute, recovery, UI review, final approval or merge. Retained background files in the original set remain counted in both versions. Adding the separate, unchanged `agents/dev-loop.agent.md` role instruction yields 91,146 / 694,598 versus 87,217 / 666,051.

This is a route-scoped conservative surface including applicable referenced owners, not an observed prompt or complete mandatory-read claim. Startup/envelope emits four route reads; it does not traverse Markdown links. A fix push adds the CI-status contract; watch/intake/recovery/harness-specific routes add their respective owners. Other agent roles remain separate contexts. Static text measurements do not prove actual loading or token savings.
