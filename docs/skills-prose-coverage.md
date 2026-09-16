# Skills prose cleanup coverage (variation B)

Tracking issue: [2236](https://github.com/mfittko/dev-loops/issues/2236), independent A/B handoff. This record is variation B. Variation A is [PR 2237](https://github.com/mfittko/dev-loops/pull/2237) on branch `issue-2236`; B never edits A. The issue remains the canonical specification; this file tracks execution only.

## Baseline record

Frozen before any B edit.

| Input | Value |
| --- | --- |
| B base (origin/main at B start) | `66c96ee8361a9dad205de42c3008907596113347` |
| A original baseline (merge-base of `issue-2236` with `main`) | `894a5a59080222cef5a47fc3f4e962824e05bfda` |
| A comparison checkpoint named in the issue | `cc032f923b6942f567761584fd05e1a28f4af8b0` (partial implementation, not a baseline) |
| A head at B start | `eccf273da654d494bcc67cc118dc2ff4caf6cb91` |
| Issue 2236 spec revision | `updatedAt 2026-09-16T08:37:44Z`, `specDigest sha256:7d579da560ad722721fbd795426f87d1a9e80527dfd4ea2d88a9c665671f4e2a` (`scripts/loop/spec-context.mjs`) |
| Toolchain | Bun 1.4.1 (pinned by `bun run verify`) |

## Baseline divergence

`origin/main` advanced from A's baseline to B's base by PR 2233, the v1.0.3 release commits and PR 2234. Within that range the following in-scope files changed (PR 2233, emitter reconciled to ADR 0048):

- `skills/copilot-pr-followup/SKILL.md`
- `skills/docs/gate-review-sub-loop-contract.md`
- their generated `.claude/skills/` projections

A and B therefore start from different revisions of the phase 1 files. Before the A/B comparison, both variants must be reconciled onto an equivalent baseline (A rebased onto B's base, or the comparison run against a common ancestor). This record does not perform that reconciliation.

## File inventory

Revision-pinned at B base `66c96ee8361a9dad205de42c3008907596113347`. Every tracked file under `skills/` is listed. Dispositions: `pending` (inventoried but not yet processed — visible coverage, never claimed coverage), `in progress`, `changed`, `unchanged`, `generated`, `non-prose`, `blocked`.

Generated `.claude/skills/` projections carry no inventory row of their own. They are a byte-reproducible projection of these sources (`bun run assets:check`), so each source row's disposition governs its projection, and hand-editing a projection is forbidden.

| File | Disposition | Phase | Rationale |
| --- | --- | --- | --- |
| `skills/copilot-pr-followup/SKILL.md` | in progress | 1 | Phase 1 primary target: routed strategy entrypoint for `copilot_pr_followup`. |
| `skills/dev-loop/SKILL.md` | pending | 2 | Routed entrypoint skill. |
| `skills/dev-loop/scripts/dev-mode-context.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/dev-mode-context.test.mjs` | non-prose | 1 | Executable test; not agent-loaded prose. |
| `skills/dev-loop/scripts/init-phase.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/log-bash-exit-1.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/phase-files.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/post-gate-verdict-fallback.test.mjs` | non-prose | 1 | Executable test; not agent-loaded prose. |
| `skills/dev-loop/scripts/render-template.mjs` | non-prose | 1 | Executable skill script; not agent-loaded prose. |
| `skills/dev-loop/scripts/render-template.test.mjs` | non-prose | 1 | Executable test; not agent-loaded prose. |
| `skills/dev-loop/templates/bootstrap-agents.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/bootstrap-implementation-state.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/bootstrap-implementation-workflow.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/dev-mode-retrospective.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/dev-mode-review.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/dev-mode-skill-changes.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/merged-phase-plan.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/phase-doc.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/phase-summary.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/phase-variant.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/retrospective.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/review.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/slides-story-review.md` | pending | 3 | Prose-bearing template. |
| `skills/dev-loop/templates/ui-vision-review.md` | pending | 3 | Prose-bearing template. |
| `skills/docs/ab-contrast-deslop-step.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/acceptance-criteria-verification.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/agent-stall-detection.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/anti-patterns.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/artifact-authority-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/conductor-routing-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/confirmation-rules.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/contract-style-guide.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/copilot-ci-status-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/copilot-loop-operations.md` | pending | 1 | Directly coupled reference; reviewed in phase 1 for relocated obligations. |
| `skills/docs/copilot-loop-state-graph.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/cross-harness-regression-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/decision-record-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/docs-grill-step.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/entrypoint-strategies.md` | pending | 1 | Directly coupled reference; reviewed in phase 1 for relocated obligations. |
| `skills/docs/epic-tree-refinement-procedure.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/gate-review-comment-contract.md` | pending | 1 | Directly coupled reference; reviewed in phase 1 for relocated obligations. |
| `skills/docs/gate-review-sub-loop-contract.md` | in progress | 1 | Canonical owner of the fan-out/fan-in chain the phase 1 skill dispatches. |
| `skills/docs/issue-intake-procedure.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/local-planning.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/main-agent-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/merge-preconditions.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/pr-lifecycle-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/projects-queue-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/public-dev-loop-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/release-runbook.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/required-rules.json` | non-prose | 1 | Machine-consumed rule manifest; no prose to condense. |
| `skills/docs/retrospective-checkpoint-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/reviewer-loop-state-graph.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/slides-story-review-loop.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/spec-authority-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/spike-mode-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/stop-conditions.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/structural-quality.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/sub-issue-tree-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/tracker-first-loop-state.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/tracker-seam-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-artifact-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-designer-review-loop.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-e2e-scoping-step.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-review-recipe-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-smoke-harness.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/ui-validation-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/validation-policy.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/wait-watch-procedure.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/workflow-handoff-contract.md` | pending | 3 | Shared contract/reference doc. |
| `skills/docs/worktree-guidance.md` | pending | 3 | Shared contract/reference doc. |
| `skills/final-approval/SKILL.md` | pending | 2 | Routed entrypoint skill. |
| `skills/local-implementation/SKILL.md` | pending | 2 | Routed entrypoint skill. |
| `skills/loop-grill/SKILL.md` | pending | 2 | Routed entrypoint skill. |
| `skills/review/SKILL.md` | pending | 2 | Routed entrypoint skill. |
| `skills/ui-review/SKILL.md` | pending | 2 | Routed entrypoint skill. |
