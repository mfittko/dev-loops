# Docs-grill — a standard in-loop step

The dev-loop autonomously checks a change's claims against the repository contracts and docs through the surfaces below. No separate human or main-agent docs pass is required. Related editorial checks: [A/B contrast deslop](./ab-contrast-deslop-step.md) and [Slides Content & Storytelling Review Loop](./slides-story-review-loop.md).

## What it checks

- **Claims vs contracts.** Each statement a change makes about behavior is checked against the contract or doc it points at (for example `skills/docs/public-dev-loop-contract.md`, `skills/docs/conductor-routing-contract.md`).
- **Code-vs-doc drift.** Where the code path and the doc describing it have diverged, the divergence is the finding.
- **Stale references.** Links, path references, and command or script names that no longer resolve to the current file tree.
- **Contract-surface accuracy.** Whether documented inputs/outputs, flags, and outcome sets still match what the code exposes.

## Where it fires (autonomous, in-loop)

The grill rides two surfaces that already run inside the loop, so it applies on every run without a manual pass:

1. **During refinement.** The [refiner agent](../../agents/refiner.md) cross-checks the active phase against the contracts and docs it touches as part of producing the refined plan, surfacing drift as a refinement finding while the claim is still being verified. The local-first refine step (#951) is the in-loop consumer: its CLI (`scripts/refine/refine-plan-file.mjs`) classifies each finding with `classifyDocsGrillFinding`, then the pure core contract (`packages/core/src/loop/plan-file-refine-contract.mjs`) validates the dispositions and records them into the plan file under a `Docs-grill findings` section before stopping at the local human-review checkpoint. The contract takes pre-classified dispositions rather than importing the classifier, so published `@dev-loops/core` stays free of any `scripts/` import.
2. **At the pre-approval gate.** The `docs` review angle in `gates.preApproval.angles` (see `packages/core/src/config/extension-defaults.yaml`) resolves to the [docs persona](../../agents/docs.md) in review mode, which audits documentation correctness for the change as one fan-out angle of the [gate review sub-loop](./gate-review-sub-loop-contract.md).

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
