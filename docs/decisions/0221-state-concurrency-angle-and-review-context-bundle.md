# 0221. State-concurrency angle wiring, sibling sweep and bounded review context

## Status

Accepted, 2026-11-01 ([issue 3005](https://github.com/mfittko/dev-loops/issues/3005), parent [issue 2841](https://github.com/mfittko/dev-loops/issues/2841)).

## Context

A study of 20 merged PRs found that 88% of 50 late Copilot code threads sit in a file the gate also flagged. The gate lenses and the reviewer context do not reach those sibling and adjacent defects. Three gaps cause most of them:

- The `state-concurrency` angle exists in the shared gate defaults and shares the `determinism-state` group with `determinism`. No change category maps to it, so subtractive dynamic angle resolution drops it on every dynamically resolved round.
- The shared reviewer brief names no sibling-defect checks after a finding.
- The reviewer context is the round diff plus an adjacent-code bundle. Nothing points a reviewer at the importers or sibling functions of a changed shared mechanism.

## Decision

The bundle ships in three slices. Each slice carries its own evidence.

1. Angle wiring. `LOGIC_CHANGE` selects `state-concurrency` in `CATEGORY_ANGLE_MAP`. The `state-concurrency` prompt gains three checks: a precondition check before a destructive write that a concurrent change can invalidate, proof bound to the owning repo, PR or execution, and elapsed time never treated as proof that a process stopped. The existing `determinism-state` group covers the new angle, so with the shipped determinism-state grouping in grouped fan-out mode the reviewer unit count of a logic-change round does not grow. This does not hold for per-angle mode, a pool without determinism, a groups table without determinism-state, or a carry-forward of determinism with a non-clean state-concurrency on a non-code delta.
2. Sibling sweep. The shared reviewer brief gains one clause under one rule ID in one contract home. After a finding in a function, the reviewer checks the opposite direction, concurrent invocation and alternate input forms of that function, and checks that a fix covers every call site.
3. Bounded adaptive context. When a diff changes an exported function, a state writer or a guard, the context bundle adds its importers and sibling functions. A per-round byte and file cap in config bounds the expansion. The brief states that reading these files is expected and names the files the cap dropped.

No change touches the judge, the fan-in, the round cap or the known-findings rule. Every expansion has a cap.

## Consequences

Logic-change rounds review concurrency, liveness and ownership binding without an added unit under the shipped grouping in grouped fan-out mode. The `state-concurrency` angle now has a derived review surface of code kinds via gate-carry-forward, so a test-only, config-only or docs-only delta can carry it forward. The `state-concurrency` prompt adds a fixed amount of reading text per round. The context expansion adds reading bytes up to the configured cap. Slice 1 records the unit count and added prompt bytes before and after in its PR.
