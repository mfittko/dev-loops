# Docs index

Start here for repository documentation.

## Current operator + contract surface

- [Implementation State](./IMPLEMENTATION_STATE.md) — current execution snapshot and fresh-session read order
- [Implementation Workflow](./IMPLEMENTATION_WORKFLOW.md) — workflow/process authority boundaries
- [Conductor Routing Contract](./conductor-routing-contract.md) — canonical outer-loop routing contract
- [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md) — canonical family-local PR lifecycle contract
- [Artifact Authority Contract](../skills/docs/artifact-authority-contract.md) — canonical artifact-selection model (tracker-first, local-planning, and PR-body-as-spec) and the local-first plan-file flow
- [Local-Planning Flow](../skills/docs/local-planning-flow.md) — operator sequence for the local-first plan-file flow
- [Local-Planning Worked Example](../skills/docs/local-planning-worked-example.md) — one plan file through every stage of the flow
- [Spike-mode Contract](../skills/docs/spike-mode-contract.md) — operator sequence for time-boxed exploratory runs: start from a question, reach findings, then discard or graduate into a plan file
- [Tracker Story PR Contract](./tracker-story-pr-contract.md) — canonical tracker-first story/PR contract
- [Sub-Issue Tree Contract](./sub-issue-tree-contract.md) — deterministic pattern for epic decomposition with GitHub sub-issue trees
- [Copilot Loop State Graph](./copilot-loop-state-graph.md)
- [Reviewer Loop State Graph](./reviewer-loop-state-graph.md)
- [Gate Review Comment Contract](./gate-review-comment-contract.md)
- [Worktree Usage Guidance](./worktree-guidance.md) — canonical local checkout isolation and cleanup rules
- [Steering Contract](./steering-contract.md)
- [UI Validation Contract](./ui-validation-contract.md)
- [UI Smoke Harness](./ui-smoke-harness.md)
- [UI Artifact Contract](./ui-artifact-contract.md)
- [UI Designer + Vision Review Loop](./ui-designer-review-loop.md)
- [Slides Content & Storytelling Review Loop](./slides-story-review-loop.md)
- [A/B Contrast Deslop Step](./ab-contrast-deslop-step.md)
- [Docs-Grill Step](./docs-grill-step.md) — autonomous in-loop check of a change against its contracts/docs

## Active local phase doc

- [Phase 8 Plan](./phases/phase-8.md) — active phase plan

## Deferred local phase docs

- [Phase 7 Plan](./phases/phase-7.md) — deferred second-repo pilot plan

## Articles

- [Introducing dev-loops](./articles/introducing-dev-loops.md) — start here: what dev-loops is, the proof from its own history, and how to adopt it
- [dev-loops: A Deep Dive](./articles/dev-loops-deep-dive.md) — deep dive in two parts: why every handoff is an explicit decision on a state graph, then measuring the waiting between actions

## Presentations

- [Applied Dev Loops Presentation](./presentations/applied-dev-loops-presentation.md)
- [Process Observability Presentation](./presentations/process-observability-presentation.md)
- `docs/presentations/style.css`

## Canonical-owner pointers

- [Library vs Packages Core Boundary](./lib-vs-packages-core-boundary.md) — ownership boundary between `lib/`, `packages/core/`, and `scripts/_core-helpers.mjs`
- [Outer Loop State Graph](./outer-loop-state-graph.md) → [Conductor Routing Contract](conductor-routing-contract.md) (symlink)
- [Tracker-First Story-to-PR Contract](./tracker-story-pr-contract.md) → [Tracker Story PR Contract](tracker-story-pr-contract.md) (pointer)
- [Copilot CI Status Contract](../skills/docs/copilot-ci-status-contract.md) → [Copilot CI Status Contract](../skills/docs/copilot-ci-status-contract.md) (canonical)
- [README Audit Rubric](./readme-audit-rubric.md) — single owner of README.md's intended semantic properties (on-demand LLM-judge audit)

## See also

- [README](../README.md) — repo overview and workflow posture
- [Extension README](../extension/README.md) — command surface, package install, and configuration
- [Dev Loop Contract](../skills/docs/public-dev-loop-contract.md) — canonical routing contract
- [AGENTS.md](../AGENTS.md) — repo working agreement

## Queue mode

- [Projects Queue Contract](./projects-queue-contract.md) — minimal board contract for GitHub Projects V2 queue tooling
- [Queue Board Setup](./queue-board-setup.md) — one-time GitHub Projects V2 board setup for dev-loop queue
- [Queue Mode SPEC](./specs/queue-mode/SPEC.md) — queue mode specification
