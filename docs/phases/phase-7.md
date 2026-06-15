# phase-7 durable plan

## Status

deferred

## Reconciliation note

Phase 7 remains a valid planned second-repo pilot, but it is not the active phase. No target repository has been chosen yet and the bounded external pilot has not started. Phase 8 was pulled forward ahead of this pilot, so this document is now a deferred plan rather than an in-progress phase.

## Objective

Prove that `dev-loops` works outside this bootstrap repository in one real second repository through the preferred GitHub-first workflow, using source-loaded consumption only, and capture only the minimum portability fixes and durable decisions needed before broader agent generalization or package-strategy work.

## Why this phase exists now

Phase 6 established the public baseline: the repo is public, MIT licensed, and CI-backed. The next highest-value step is not broader abstraction; it is one bounded downstream pilot that replaces assumptions with evidence.

This phase exists to answer, in one real non-bootstrap repo:

- whether install and skill discovery work outside this repo
- whether one bounded GitHub-first loop path works without bootstrap-repo assumptions
- whether one thin downstream override can coexist with upstream assets without requiring a full overlay/update system yet
- which portability issues are truly blocking reuse versus merely theoretical

## In scope

- track Phase 7 through a GitHub issue and PR in this repository
- choose exactly one non-bootstrap target GitHub repository and record the choice plus rationale
- apply these target-repo selection criteria:
  - GitHub-hosted
  - non-bootstrap relative to this repo
  - safe for a bounded non-mutating pilot
  - able to exercise the preferred `dev-loop` routed Copilot PR-follow-up analysis path
- use source-loaded / GitHub-checkout consumption only for the pilot
- validate in the target repo:
  - package and skill discovery outside this bootstrap repo
  - readiness output such as `/dev-loops doctor` or equivalent install/discovery reporting
  - one exact bounded, non-mutating loop skill path:
    - preferred path: run `dev-loop` in inspection / analysis mode only, producing a next-step recommendation for an existing issue or PR without mutating GitHub state or repository files
    - fallback path: run `dev-loop` refinement / planning only, without implementation, only if the preferred routed Copilot PR-follow-up analysis path is not valid for the chosen repo and the fallback is explicitly justified
- exercise one thin repo-local override and document:
  - the override form for this phase is one repo-local skill overlay or wrapper that changes one bounded repo-specific behavior such as required reads, validation guidance, or issue/PR context framing
  - what is overridden
  - what remains upstream-owned
  - what manual update expectation exists downstream
- fix only the smallest portability issues in this repo required for the pilot to succeed
- capture prioritized findings with explicit fixed-now vs deferred decisions
- update durable docs only where pilot findings change durable project truth

## Explicit non-goals

- no npm publishing, registry setup, or release automation
- no multi-repo rollout
- no broad agent generalization sweep
- no formal overlay / merge / update machinery for downstream customizations
- no full extension redesign or setup automation
- no long-running watcher validation as a success requirement
- no broad cleanup in the target repo beyond the smallest pilot-specific setup needed
- no rewriting every skill or prompt based on a single pilot
- no package-strategy finalization beyond the source-loaded boundary already chosen for this phase

## Acceptance criteria

- a GitHub issue exists for Phase 7 and names:
  - the chosen target repo
  - the preferred pilot path
  - the thin override being exercised
- [Phase 7 Plan](./phase-7.md) records the same target repo, path, and boundary
- the pilot uses source-loaded / GitHub-checkout consumption only; no npm publication is required
- in the target repo, packaged skill discovery works well enough to confirm the install is visible outside this bootstrap repo
- in the target repo, `/dev-loops doctor` or equivalent readiness output clearly shows whether install/discovery succeeded
- in the target repo, at least one packaged loop skill succeeds in a bounded, non-mutating path
- the preferred success path is `dev-loop` routed to Copilot PR-follow-up analysis; any fallback is explicitly justified in the issue and phase doc
- one thin local override is exercised successfully in the target repo without copying the full upstream skill/package surface; for this phase, the override must be one repo-local skill overlay or wrapper that changes only one bounded repo-specific behavior
- every breakage found during the pilot is recorded with a disposition:
  - fixed in Phase 7
  - deferred to a named follow-up
  - blocked pending decision
- any portability fix made in this repo because of the pilot has targeted regression coverage or equally explicit deterministic validation
- `npm test` passes locally in this repo after any Phase 7 changes
- GitHub Actions Node 24 CI passes on the Phase 7 PR

## Definition of done

- one bounded pilot has been completed in one real second repo
- the exact install mode, commands used, and successful path are documented clearly enough for a maintainer to repeat
- if any target-repo changes are needed for the pilot, they must be made on a dedicated branch or PR in that target repo rather than as undocumented local-only drift
- the thin local override example is documented, including what it proves and what it does not prove
- all discovered portability issues are either fixed now or explicitly deferred by name
- any landed fixes in this repo are validated locally and by existing Node 24 CI
- the GitHub issue, PR, and [Phase 7 Plan](phase-7.md) preserve the same bounded truth:
  - one repo only
  - source-loaded only
  - one bounded skill path only
  - no publish / no overlay system / no broad generalization
- the PR body is structured with summary, scope/context, acceptance criteria, definition of done, and non-goals
- no Phase 8+ work is partially shipped under the Phase 7 label

## Validation approach

- for each pilot-discovered bug in this repo, write the smallest failing regression test first when practical
- prefer narrow contract tests for path resolution, skill discovery, readiness reporting, repo-layout assumptions, and local override boundaries
- if a finding is not realistically automatable, record a deterministic manual reproduction checklist and expected outcome
- run the pilot from a clean checkout of the chosen target repo using the documented source-loaded integration path
- verify packaged skill discovery and readiness output in the target repo
- execute the chosen bounded non-mutating loop path and capture the result
- exercise the chosen thin local override and capture what changed
- in this repo, run:
  - `npm test`
  - `git diff --check`
- require passing Node 24 GitHub Actions CI on the Phase 7 PR
- review the issue, phase doc, and PR body for scope drift before finalization

## Durable decisions

- Phase 7 is GitHub-first and should be tracked through a GitHub issue and PR in this repo
- Phase 7 is intentionally limited to one target repo
- the integration boundary for this phase is source-loaded / GitHub-checkout consumption, not published-package consumption
- success requires discovery/readiness proof, one bounded non-mutating skill path, and one thin local override
- success does not require publishing, multi-repo proof, watcher validation, overlay-system design, or broad agent cleanup
- any downstream customization in this phase should stay thin, local, and explicitly documented rather than generalized prematurely
- for the Phase 7 portability path, `pi install git:github.com/mfittko/dev-loops` exposes the extension command surface and packaged skills through `package.json` `pi.skills`
- `/dev-loops install` and `/dev-loops update` are removed; use `pi install` / `pi update` directly
- phase refinement for this repo should default to fan-out / fan-in planning with multiple variants before converging on one merged plan

## Open questions

- which repository is the best single Phase 7 pilot target?
- can that repo safely exercise the preferred `dev-loop`-routed Copilot PR-follow-up inspection path?
- what exact repo-specific behavior should the thin skill overlay or wrapper adjust in the chosen target repo?
- if the target repo needs changes, what is the smallest acceptable footprint there?

## Operational closure status

Phase 7 is currently deferred before execution. The merged bounded plan remains recorded here for later reuse, but the pilot itself has not started and no target repository has been selected.

Bounded workflow-remediation prep slices under issue #70 may land independently to improve shared workflow footing. They are not part of this phase and do not replace it.

Do not treat this plan as the active phase again unless the repo explicitly reprioritizes back to the second-repo pilot.

## Links to execution artifacts

- local execution artifacts may exist under `tmp/phases/phase-7/`
