# 0251. The round cap is soft: past it only a named human decision blocks

## Status

Accepted, 2026-11-05 ([issue 3105](https://github.com/mfittko/dev-loops/issues/3105)).

Amends [ADR 0208](./0208-draft-cap-round-fixed-goes-ready.md), [ADR 0224](./0224-cap-round-proof-for-adr-waiver-and-docs-tests-chain-extension.md) and the draft-gate low deferral of [ADR 0188](./0188-low-nit-never-block.md) (as amended by [ADR 0196](./0196-pre-approval-gate-low-nit-never-block.md)). Every other decision of those records stays in force, and the records stay unedited.

## Context

`pastCapBlockers` composes a `blocked` verdict for almost any act item past the cap: a resurfaced medium, a low, an act item without a `judgeFix`, a medium `defer` without a follow-up issue. The PR then waits for a human on findings the fixer and the pre-push delta review can settle. The cap is meant as a backstop for non-convergence, not as a stop on every residual finding.

## Decision

1. The cap is soft and applies before `pre_approval_gate`. Rounds 1 through N run in full.
2. A `round_cap_reached` blocker exists only for a named human decision. This slice ships the cap-round part (round N). A round after the cap round stays refused under `GATE-EXEC-ROUND-CAP` until a later slice of issue 3105 opens the past-cap path:
   - a `high` act item without a non-blank string `judgeFix` (at the cap round a `high` act item with a non-blank `judgeFix` goes to the fixer), or a `high` the judge defers or rejects;
   - a `failOpen` finding the judge defers or rejects;
   - a `question`-severity act item;
   - a closed finding with an unknown severity or no valid disposition (evidence integrity, reason `severity_disagreement`).
3. Security and spec-change blocks ride on severity `high` and the spec digest check. This slice adds no finding field.
4. A `medium`, `low`, `nit` or unknown-severity act item and a `medium` without `failOpen` that the judge defers or rejects never block. They reach the fixer and the pre-push delta review.
5. A `failOpen` finding blocks when the judge defers or rejects it. A non-`high` `failOpen` act item goes to the fixer.
6. A draft-gate `low` act item at the cap round is fixed, not deferred. The `pre_approval_gate` low deferral is unchanged. That behavior change ships in a later slice of issue 3105 and this record states the decision.

The override command, the effective cap, the Copilot-loop cap and the no-dead-end rule are scoped by issue 3105 and follow in later slices.

## Consequences

This is a hard cut. The ledger shape is unchanged. Only fewer findings block. A PR past the cap with medium, low or nit residue reaches the fixer instead of `blocked`.
