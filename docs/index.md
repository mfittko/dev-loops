# Docs index

Start here for repository documentation.

## Current operator + contract surface

- [Implementation State](./IMPLEMENTATION_STATE.md) — current execution snapshot and fresh-session read order
- [Implementation Workflow](./IMPLEMENTATION_WORKFLOW.md) — workflow/process authority boundaries
- [Conductor Routing Contract](../skills/docs/conductor-routing-contract.md) — canonical outer-loop routing contract
- [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md) — canonical family-local PR lifecycle contract
- [Artifact Authority Contract](../skills/docs/artifact-authority-contract.md) — canonical artifact-selection model (tracker-first, local-planning, and PR-body-as-spec) and the local-first plan-file flow
- [Tracker Seam Contract](../skills/docs/tracker-seam-contract.md) — the `Tracker` provider interface/registry (issue #1408); GitHub is the built-in default, external providers are a post-1.0 drop-in
- [Local-Planning Flow](../skills/docs/local-planning-flow.md) — operator sequence for the local-first plan-file flow
- [Local-Planning Worked Example](../skills/docs/local-planning-worked-example.md) — one plan file through every stage of the flow
- [Spike-mode Contract](../skills/docs/spike-mode-contract.md) — operator sequence for time-boxed exploratory runs: start from a question, reach findings, then discard or graduate into a plan file
- [Tracker Story PR Contract](../skills/docs/tracker-story-pr-contract.md) — canonical tracker-first story/PR contract
- [Sub-Issue Tree Contract](../skills/docs/sub-issue-tree-contract.md) — deterministic pattern for epic decomposition with GitHub sub-issue trees
- [Copilot Loop State Graph](../skills/docs/copilot-loop-state-graph.md)
- [Reviewer Loop State Graph](../skills/docs/reviewer-loop-state-graph.md)
- [Gate Review Comment Contract](../skills/docs/gate-review-comment-contract.md)
- [Worktree Usage Guidance](../skills/docs/worktree-guidance.md) — canonical local checkout isolation and cleanup rules
- [Steering Contract](./steering-contract.md)
- [UI Validation Contract](../skills/docs/ui-validation-contract.md)
- [UI Smoke Harness](../skills/docs/ui-smoke-harness.md)
- [UI Artifact Contract](../skills/docs/ui-artifact-contract.md)
- [UI Designer + Vision Review Loop](../skills/docs/ui-designer-review-loop.md)
- [UI-Review Run/Auth Recipe Contract](../skills/docs/ui-review-recipe-contract.md) — per-project run/login/flow recipe for `/loop-review-ui`
- [Slides Content & Storytelling Review Loop](../skills/docs/slides-story-review-loop.md)
- [A/B Contrast Deslop Step](../skills/docs/ab-contrast-deslop-step.md)
- [Docs-Grill Step](../skills/docs/docs-grill-step.md) — autonomous in-loop check of a change against its contracts/docs

## Active local phase doc

- [Phase 8 Plan](./phases/phase-8.md) — active phase plan

## Deferred local phase docs

- [Phase 7 Plan](./phases/phase-7.md) — deferred second-repo pilot plan

## Articles

- [Introducing dev-loops](./articles/introducing-dev-loops.md) — start here: what dev-loops is, the proof from its own history, and how to adopt it
- [dev-loops: A Deep Dive](./articles/dev-loops-deep-dive.md) — deep dive in two parts: why every handoff is an explicit decision on a state graph, then measuring the waiting between actions
- [The State Graph Is the Surface](./articles/the-state-graph-is-the-surface.md) — reframes dev-loops as a graph/loop control surface: modeled state is authoritative, loops traverse it, and GitHub supplies the durable tracker/review evidence plane
- [How dev-loops Decided Itself Into Shape](./articles/how-dev-loops-decided-itself.md) — the history: forty dated architecture decisions, the two reversals, and the outcomes, read straight from the decision log

## Presentations

- [Applied Dev Loops Presentation](./presentations/applied-dev-loops-presentation.md)
- [Process Observability Presentation](./presentations/process-observability-presentation.md)
- [The State Graph Is the Surface (deck)](./presentations/state-graph-surface-presentation.md) — the graph/loop reframe in presentation form
- [How dev-loops Decided Itself Into Shape (deck)](./presentations/how-dev-loops-decided-itself.html) — the evolution/history narrated through the decision log
- `docs/presentations/style.css`

## Canonical-owner pointers

- [Library vs Packages Core Boundary](./lib-vs-packages-core-boundary.md) — ownership boundary between `lib/`, `packages/core/`, and `scripts/_core-helpers.mjs`
- [Outer Loop State Graph](../skills/docs/outer-loop-state-graph.md) → [Conductor Routing Contract](../skills/docs/conductor-routing-contract.md) (symlink)
- [Tracker-First Story-to-PR Contract](../skills/docs/tracker-story-pr-contract.md) → [Tracker Story PR Contract](../skills/docs/tracker-story-pr-contract.md) (pointer)
- [Copilot CI Status Contract](../skills/docs/copilot-ci-status-contract.md) → [Copilot CI Status Contract](../skills/docs/copilot-ci-status-contract.md) (canonical)
- [README Audit Rubric](./readme-audit-rubric.md) — single owner of README.md's intended semantic properties (on-demand LLM-judge audit)

## See also

- [README](../README.md) — repo overview and workflow posture
- [Extension README](../extension/README.md) — command surface, package install, and configuration
- [Dev Loop Contract](../skills/docs/public-dev-loop-contract.md) — canonical routing contract
- [AGENTS.md](../AGENTS.md) — repo working agreement

## Queue mode

- [Projects Queue Contract](../skills/docs/projects-queue-contract.md) — minimal board contract for GitHub Projects V2 queue tooling
- [Queue Board Setup](../skills/docs/queue-board-setup.md) — one-time GitHub Projects V2 board setup for dev-loop queue
- [Queue Mode SPEC](./specs/queue-mode/SPEC.md) — queue mode specification
