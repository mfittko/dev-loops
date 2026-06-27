# Docs-grill — a standard in-loop step

A repeatable step that interrogates a change against the repository's own contracts and docs while the dev-loop runs. It is a sibling of the [A/B contrast deslop step](./ab-contrast-deslop-step.md) and the [Slides Content & Storytelling Review Loop](./slides-story-review-loop.md): those judge prose and narrative; this one judges whether the change's claims still match the contracts they reference.

It runs autonomously in-loop. The dev-loop performs the grill itself through the surfaces below; it does not depend on a human or the main agent running a separate manual docs pass.

## What it checks

- **Claims vs contracts.** Each statement a change makes about behavior is checked against the contract or doc it points at (for example `skills/docs/public-dev-loop-contract.md`, `docs/conductor-routing-contract.md`).
- **Code-vs-doc drift.** Where the code path and the doc describing it have diverged, the divergence is the finding.
- **Stale references.** Links, path references, and command or script names that no longer resolve to the current file tree.
- **Contract-surface accuracy.** Whether documented inputs/outputs, flags, and outcome sets still match what the code exposes.

## Where it fires (autonomous, in-loop)

The grill rides two surfaces that already run inside the loop, so it applies on every run without a manual pass:

1. **During refinement.** The [refiner agent](../agents/refiner.agent.md) cross-checks the active phase against the contracts and docs it touches as part of producing the refined plan, surfacing drift as a refinement finding while the claim is still being verified.
2. **At the pre-approval gate.** The `docs` review angle in `gates.preApproval.angles` (see `packages/core/src/config/extension-defaults.yaml`) resolves to the [docs persona](../agents/docs.agent.md) in review mode, which audits documentation correctness for the change as one fan-out angle of the [gate review sub-loop](./gate-review-sub-loop-contract.md).

## The keep/fix rule

Each finding takes exactly one disposition, codified by `classifyDocsGrillFinding` in `scripts/loop/docs-grill-contract.mjs`:

| Finding | Disposition |
| --- | --- |
| Real drift between code/behavior and a contract claim | `record_finding` — record it; the change contradicts a contract that still holds |
| Doc-only drift small enough for this branch | `fix_in_place` — correct the doc on the same branch |
| Doc-only drift too large for this branch | `route_followup` — open or note a follow-up |
| Cosmetic wording nit | `ignore_cosmetic` — do not block and do not fix here |

The grill informs the loop; the human still owns merge. A cosmetic nit never blocks a gate.

## Current minimal validation seam

The pure classifier at `scripts/loop/docs-grill-contract.mjs` codifies the keep/fix boundary:
- `DOCS_GRILL_FINDING_KINDS` — the bounded `drift` / `stale_reference` / `cosmetic` finding kinds
- `DOCS_GRILL_DISPOSITIONS` — the bounded `record_finding` / `fix_in_place` / `route_followup` / `ignore_cosmetic` set
- `classifyDocsGrillFinding(finding)` — maps a finding to its disposition and fails closed (`invalid_finding`) on an unknown kind

This keeps the disposition rule testable; the firing surfaces (refiner cross-check, gate `docs` angle) carry the grill itself.

## First run

The [local-first epic (#947)](https://github.com/mfittko/dev-loops/issues/947) tree refinement is the first run of this step. Each node of the epic tree was refined with a per-node grill against the contracts it reuses — `--plan-file` reuses the existing `local_implementation` strategy and `local_phase` target (no new strategy), the plan reuses the phase-doc format under `docs/phases/`, and promotion opens a single draft PR as the spec-of-record — surfacing each contract claim for verification during the refiner+grill fan-out, while refining. The ratified design decisions on #947 record the grilled-and-confirmed contract reuse.
