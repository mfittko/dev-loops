# dev-loops Plan

`dev-loops` is a shared home for Pi-centered development workflow infrastructure.

The durable goal is to ship a reusable toolkit for Pi-based local and GitHub-first development loops without letting workflow mechanics drift back into ad hoc markdown or repo-specific shell glue.

## What this plan is for

Use `PLAN.md` for **durable repo-level truth**:
- product intent
- architecture direction
- workflow contract
- medium-term roadmap

Do **not** use `PLAN.md` for one-off issue execution plans, PR-specific checklists, or temporary implementation notes. Those belong in:
- GitHub issues / PRs
- `Phase Plan` (`docs/phases/phase-<n>.md`) for active local-phase planning
- `tmp/` artifacts for transient execution detail

## Current repo posture

- This repo is currently a **source-loaded workspace**, not a published npm-package workflow.
- `dev-loop` is the single public workflow entrypoint; see [Public Dev Loop Contract](./skills/docs/public-dev-loop-contract.md) for the canonical public routing/shorthand contract.
- For active implementation and release work in this repo, the default routed path should still prefer the GitHub-first internal strategies when practical.
- The local implementation strategy remains supported when the user explicitly wants local phase-bounded work.
- GitHub issues are the backlog and GitHub PRs are the main execution trail for remote-loop work.
- Installing the package with `pi install git:github.com/mfittko/dev-loops` exposes packaged skills through `package.json` `pi.skills`; `/dev-loops install` and `/dev-loops update` are removed — use `pi install` / `pi update` directly.

## Product intent

This repo is meant to provide four durable layers.

### 1. Role agents

Reusable role definitions under `agents/` for work such as:
- coordination
- implementation
- docs
- review
- fixing
- quality
- refinement

These should stay broadly reusable and should not become thinly disguised repo-specific workflow scripts.

Thin workflow entrypoint agents are still allowed, but they must stay thin, defer sequencing and workflow policy to the skill, and avoid replacing the generic role agents.

### 2. Workflow skills

Reusable Pi workflow skills under `skills/`, especially:
- `dev-loop` as the single public façade for start/continue/state requests
- split internal route packs behind `dev-loop`: `issue-intake`, `copilot-pr-followup`, `local-implementation`, and `final-approval`

Skills own sequencing, handoff rules, and operator-facing workflow policy.
The public entrypoint should expose user intent; internal strategy names should stay minimal and should not be preserved as compatibility shims without an explicit active contract.

### 3. Extension and CLI surface

Thin package-level UX under `extension/` and `cli/` for:
- readiness and diagnostics
- shell access to shared deterministic helpers
- lightweight orchestration glue that defers real mechanics to scripts/core modules

### 4. Deterministic support code

Deterministic helpers under `packages/core/` and `scripts/` for the mechanical parts of the workflows, including:
- review-thread parsing
- loop-state detection
- GitHub request/watch helpers
- issue/PR linkage
- phase-file support
- conductor-adjacent ownership, routing, inspection, and steering seams

## Architecture rules

### Markdown keeps policy; helpers keep mechanics

Keep durable judgment and operator guidance in markdown, but move repeatable operational logic behind deterministic helpers whenever practical.

### Thin wrappers over shared contracts

Prefer thin entrypoint agents, thin skills, thin CLI wrappers, and thin extension surfaces over duplicated logic in many places.

### Canonical-over-compatibility posture

Prefer one concise canonical workflow/documentation surface over backwards-compatibility shims, legacy aliases, or duplicate prompt layers.

Do not preserve legacy names or compatibility seams by default. Keep them only when an explicitly approved active contract still requires them.

### Package-first where it helps, source-loaded where it is practical

Shared pure logic should live in reusable package-friendly modules where practical, but the repository must remain runnable as a source-loaded checkout during the current phase of the project.

### GitHub-first for remote work

For GitHub/Copilot workflows, GitHub issues and PRs are the authoritative execution trail. Local docs should explain and support that flow, not replace it with a parallel backlog.

### Proposal-first new-idea safety layer

For new ideas that are not already anchored to an existing issue, keep the proposal-first intake posture used by the GitHub-first autopilot workflow: classify first, emit a proposal artifact, and mutate GitHub state only after the proposal is explicit and approved. The safety layer should fail closed through the bounded stop states `stopped_overlap_needs_decision`, `stopped_low_confidence`, `stopped_explicit_reject`.

### Durable docs must stay aligned

Whenever a merged slice changes durable project truth, update the affected durable docs before considering the slice closed. In practice this usually means checking some combination of:
- [README](./README.md)
- `PLAN.md`
- [Implementation State](./docs/IMPLEMENTATION_STATE.md)
- [Implementation Workflow](./docs/IMPLEMENTATION_WORKFLOW.md)
- relevant contract/state-graph docs under `docs/`
- [Scripts Documentation](./scripts/README.md) when a script surface changes

## Current shipped surface

Today the repository already includes:
- reusable role agents
- packaged workflow skills for local and GitHub-first work
- a `/dev-loops` extension and `dev-loops` shell CLI
- deterministic GitHub helpers for review-thread capture, Copilot request/watch, issue-to-PR detection, and reviewer draft staging
- deterministic loop-state helpers for Copilot, reviewer, tracker, and outer-loop orchestration
- conductor-adjacent ownership, routing, inspection, and steering contracts in the source tree
- root and package-level tests plus CI on Node 24

## Roadmap

### Completed foundation

The initial foundation phases are complete:
- Phase 1 — imported-asset normalization
- Phase 2 — dedicated refiner-agent support
- Phase 3 — extension/setup UX
- Phase 4 — shared deterministic library/package work
- Phase 5 — deterministic script surfaces
- Phase 6 — public release hardening

See [Implementation State](docs/IMPLEMENTATION_STATE.md) for the current execution snapshot.

### Current active phase

#### Phase 8 — workflow configuration contract stabilization

Phase 8 is the current active durable phase. `main` already includes a partial Phase 8 implementation: the dev-loop config schema/loader, reviewer-role resolution, strategy-default routing integration, conductor model wiring, and the supporting contract tests.

The durable phase plan lives in [Phase 8 Plan](./docs/phases/phase-8.md).

This ordering is an explicit deviation from the repo's normal one-phase-at-a-time posture: Phase 8 was pulled forward before the planned Phase 7 pilot executed. The durable docs now record that deviation directly instead of leaving contradictory claims about which phase is current.

### Deferred earlier phase

#### Phase 7 — bounded second-repo pilot (deferred)

Phase 7 is still a valid planned pilot, but it is currently deferred rather than completed. No target repository has been chosen yet and the bounded second-repo portability proof has not run.

Success for Phase 7 still means:
- one real non-bootstrap target repo
- one bounded non-mutating pilot path
- one thin downstream override example
- only the smallest portability fixes required for that pilot

Keep the durable plan parked at [Phase 7 Plan](./docs/phases/phase-7.md) until the repo is ready to resume that portability proof.

A separate supporting memo at [Workflow Remediation Prep](./docs/archive/workflow-remediation-prep.md) records the workflow-remediation findings behind issue #70. That memo supports bounded prep chunks, but it is not a roadmap phase and does not replace the deferred Phase 7 pilot.

### After Phase 8

Once Phase 8 closes, either resume the deferred Phase 7 pilot or deliberately replan from current GitHub evidence instead of letting both phases stay half-active in durable docs. Likely follow-up areas still include:
- finishing any remaining Phase 8 closure work
- the downstream portability proof preserved in Phase 7
- further shrinkage of markdown-owned operational logic
- clearer operator-facing inspection / steering / projection surfaces
- broader multi-repo and tracker-first adoption only after the bounded pilot proves the basics

## Current non-goals

For the current stage of the repo, avoid expanding into:
- a generic workflow DSL
- support for every forge or every repo convention
- broad publish/distribution strategy work before the source-loaded boundary is proven well enough
- a parallel backlog system outside GitHub issues and PRs
- large issue-specific execution plans embedded in durable repo docs
