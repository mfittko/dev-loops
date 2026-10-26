# 0196. A low-only pre_approval_gate round composes clean in every round

## Status

Accepted — 2026-10-26 ([issue 2724](https://github.com/mfittko/dev-loops/issues/2724), slice 0)

Amends [ADR 0188](./0188-low-nit-never-block.md) for `pre_approval_gate`. ADR 0188 treated `pre_approval_gate` as never past the cap. All other decisions of ADR 0188 are unchanged. The record of ADR 0188 stays unedited.

## Context

On PR 2945, the `pre_approval_gate` ran 5 rounds. Round 5 at `77a28e841627f4a72e3f6ca246f6397a9d684792` had 0 high, 0 medium and one judge-acted low, and that low blocked `detect-checkpoint-evidence.mjs` ("judge act list is not empty"). Each fix moved the head into a full re-review that found the next low. `pre_approval_gate` has no round count, so the `GATE-EXEC-LOW-FIX-UNTIL-CAP` coercion never applied there. Operator decision of 2026-10-26: low and nit findings never block at `pre_approval_gate`.

## Decision

- Coercion. At `pre_approval_gate`, `applyJudgeDispositions` applies the past-cap coercion of `GATE-EXEC-LOW-FIX-UNTIL-CAP` in every round. A cluster holding a `low` becomes `defer` with a synthesized `followUpDraft`, and an all-`nit` cluster becomes `reject`, both with the reason `low_fix_until_cap`. The operator-visibility test stays the judge's rule for its own `defer` or `reject` choice. When the only deferral target is the PR itself, `judge-pass.mjs` records the coerced `defer` as `reject` in `--ledger-out` and in the durable findings log. The round composes `clean`.
- Unchanged. A `failOpen` disposition on a cluster holding a `low` still promotes the members to `medium` and blocks. `high`, `medium` and `question` keep their behavior.
- Fixer. `emit-fixer-work-order.mjs` refuses a low-only act list at `pre_approval_gate` with `low_fix_until_cap`.
- Reuse. `resolveDraftRoundCap` returns one added field, `lowFixCapped`. It adds no cap module and no counter.

## Consequences

A `pre_approval_gate` round with only low and nit findings ends in one round with no fixer pass and no head change. The slice 2 convergence rule of issue 2724 no longer applies to low-only rounds, and its grill re-scopes it.
