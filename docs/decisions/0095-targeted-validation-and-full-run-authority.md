# 0095. Targeted validation with one local full-run authority

## Status

Accepted — 2026-09-27 ([issue #2469](https://github.com/mfittko/dev-loops/issues/2469))

## Context

The former `VALIDATE-VERIFY-BEFORE-GATE` rule directed every worker to run the full repository suite. That repeated expensive work during implementation and conflicted with the gate's need for evidence tied to an exact commit. [Issue #2469](https://github.com/mfittko/dev-loops/issues/2469) makes targeted checks the default while retaining full coverage at the applicable gate. The choice applies to tracker-backed and phase-doc-backed local work alike; their spec sources remain distinct.

## Decision

Workers select the narrowest deterministic check for changed paths through a shared classifier and record its command and outcome. Unknown or mixed surfaces require full-validation ownership; an empty selection is never a pass. `dev-loops gate resolve-validation` is the sole executable entrypoint for a local full-repository run. Its evidence is bound to the exact head SHA, requested profile, and pinned Bun toolchain; unavailable evidence is typed incomplete. Current-head CI or sanctioned local full evidence supplies the gate's full-repository result. The existing `bun run verify` suite and CI aggregate retain their coverage.

This supersedes [ADR 0080](./0080-coordinator-worker-delegation-boundary.md) for verification ownership: the coordinator still delegates tracked-file edits and targeted checks to workers, while local full-repository runs go only through `dev-loops gate resolve-validation`.

The same classifier identifies full-run commands, including wrappers, aliases, and composed suites, so changing command spelling cannot reassign ownership. This record establishes the authority boundary; runtime role enforcement and cross-gate evidence reuse belong to later slices of [issue #2466](https://github.com/mfittko/dev-loops/issues/2466).

## Consequences

Implementation checks can finish sooner without weakening the full gate. A worker cannot turn a missing full result into permission to run the suite directly. Local full runs produce auditable current-head evidence; a failed suite remains failed evidence. Node packaged-consumer and npm release-boundary checks still run when those surfaces are under test.
