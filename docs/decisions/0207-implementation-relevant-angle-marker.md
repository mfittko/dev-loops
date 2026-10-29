# 0207. Review angles carry an explicit implementation-relevance marker

## Status

Accepted — 2026-10-29 ([issue 2588](https://github.com/mfittko/dev-loops/issues/2588))

## Context

Developers and fixers edit code before any reviewer reads it. The gate angle prompts state criteria a developer can apply up front, such as test coverage and CLI contract agreement. Other angles, such as `pr-description` and `ci-guard`, concern review artifacts and give a developer nothing to act on. A projection of every angle would bury the useful criteria, and a heuristic that guesses relevance from the prompt text would drift.

The change adds a field to the angle schema and marks angles in `packages/core/src/config/extension-defaults.yaml`, which trips the ADR tripwire.

## Decision

- An angle entry takes an optional boolean `implementationRelevant`. The shipped angles `coverage`, `correctness`, `contract-surface` and `input-validation` carry `implementationRelevant: true`. An unmarked angle is excluded from every projection.
- `resolveImplementationRelevantAngles` projects the marked, enabled angles of the merged config as `{ angle, criterion }`, where the criterion is the merged `prompt`. The order is the gate order (draft, preApproval, spike), then list order. A repository override of a prompt therefore appears in the projection.
- `scripts/loop/_review-expectations.mjs` bounds the projection to 12 criteria and 2,000 criterion characters inline. The remaining angles go to `overflow`, which holds names and digest-pinned config file reads and never criterion text.
- `loop implementation-brief` shows the projection as `reviewExpectations`.
- The fixer role adapter in `emit-fixer-work-order.mjs` and `verify-fixer-disposition.mjs` accept an optional `expectations` section of the same shape. A work order without it renders, pulls and verifies unchanged. Ordinary fix orders do not emit it until a later slice.
- The marker only adds. `implementationRelevant: false` is the same as no marker and does not remove a shipped mark. An operator drops an angle from the projection by disabling it, or by not marking it.
- An overflow lists at least one digest-pinned read: the shipped defaults (named `@dev-loops/core/config/extension-defaults.yaml`, read from the package module dir where the config loader resolves them) and each repository config file present (`.devloops`, `.devloops.yaml`, `.devloops.yml`, `.devloops.json`, `.pi/dev-loop/defaults.*`). The path lists come from `check-adr-tripwire.mjs`, not a copy.
- Overflow reads are not in `workOrder.requiredReads`, so the work-order puller does not check their pins. Slice 4 binds them into the required-reads manifest.
- The section carries no authority and no gate evidence. No gate, judge or reviewer module reads it.

## Consequences

Operators mark an angle to expose it, and a custom angle is excluded until marked. The marker has no effect on angle selection or fan-out. A later slice makes ordinary fix orders emit the section and extends the same projection to the developer work order.
