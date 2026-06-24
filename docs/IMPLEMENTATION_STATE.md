# Implementation state

## Status

Phase 1 imported-asset normalization is complete, locally validated, committed, and merged. Phase 2 dedicated refiner-agent work is complete, locally validated, committed, and merged. Phase 3 package extension and setup UX work is complete, locally validated, committed, and merged. Phase 4 shared deterministic library and npm support package work is complete, locally validated, committed, and merged. Phase 5 deterministic scripts work is complete, locally validated, committed, and merged. Phase 6 public release hardening is complete, merged, and synced back to local `main`.

Phase 7 second-repo pilot is deferred, not completed. No target repository has been chosen yet and the bounded external portability proof has not run.

Phase 8 is the active durable phase. `main` already includes slice 1 of Phase 8: the dev-loop config schema/loader, reviewer-role resolution, strategy-default routing integration, conductor model wiring, and supporting tests. Additional Phase 8 closure work is still pending.

This is an explicit deviation from the repo's normal one-phase-at-a-time guidance: Phase 8 was pulled forward ahead of the planned Phase 7 pilot. The repo now documents that deviation directly instead of leaving contradictory phase claims in multiple files.

Separately, issue #70 tracks a bounded workflow-remediation preparation chain. Those chunks harden the current workflow foundation before later improvements continue. They do **not** replace the deferred Phase 7 pilot or the active Phase 8 work.

## Current source of truth

- Backlog and remote execution trail: GitHub issues and PRs
- Product/repo roadmap: [Project Plan](../PLAN.md)
- Repo contract: [Agent Instructions](../AGENTS.md)
- Workflow explainer: [Implementation Workflow](./IMPLEMENTATION_WORKFLOW.md)
- Active durable local phase plan: [Phase 8 Plan](./phases/phase-8.md)
- Deferred earlier phase plan: [Phase 7 Plan](./phases/phase-7.md)
- tmp index for fresh-context inspection if present locally: `tmp/phases/index.json`

## Supporting context


## Current phase

- Active phase: `phase-8`
- Durable phase plan: [Phase 8 Plan](phases/phase-8.md)
- Status: `active (slice-1-implemented; additional Phase 8 closure work pending)`
- Deferred earlier phase: `phase-7`
- Deviation note: Phase 8 was pulled forward ahead of the planned Phase 7 pilot and that exception is now documented explicitly.

## Next action for a fresh session

If the user says **"continue implementation"**:

1. read [README](../README.md)
2. read [Project Plan](../PLAN.md)
3. read [Agent Instructions](../AGENTS.md)
4. read [Implementation Workflow](IMPLEMENTATION_WORKFLOW.md)
5. read this file
6. read [Phase 8 Plan](phases/phase-8.md)
7. start from the public `dev-loop` entrypoint and let routing choose the right internal path
8. inspect `tmp/phases/index.json` and any useful prior artifacts only if prior context helps
9. if durable repo truth changed during the work, sync [README](../README.md), [Project Plan](../PLAN.md), [Implementation State](./IMPLEMENTATION_STATE.md), and any affected contract docs before closing the slice
11. if the request reopens the deferred Phase 7 pilot, explicitly confirm that reprioritization before treating [Phase 7 Plan](phases/phase-7.md) as the active phase again

## Next unfinished phase

Phase 8 — workflow configuration contract stabilization.

After Phase 8 closes, revisit the deferred Phase 7 second-repo pilot deliberately rather than assuming it already happened.

## Phase summary

- Completed: `phase-0` through `phase-6`
- Deferred: `phase-7` (`not started; Phase 8 pulled forward ahead of it`)
- Active: `phase-8` (`slice-1-implemented; additional Phase 8 closure work pending`)
- Later phases remain intentionally undescribed here until Phase 8 closes and the deferred Phase 7 pilot is either resumed or formally replanned
