# 0199. PURPOSE-HIGHEST-SAFE-AUTONOMY is the parent rule for issue 2937 rules

## Status

Accepted — 2026-10-27 ([issue 2937](https://github.com/mfittko/dev-loops/issues/2937))

Relates to [ADR 0188](./0188-low-nit-never-block.md). It does not amend ADR 0188.

## Context

The rules added under issue 2937 (for example ADR 0188) each argue for autonomy in their own words. The shared purpose has no single statement. Rules restate it differently and can drift apart.

## Decision

- `PURPOSE-HIGHEST-SAFE-AUTONOMY` in `skills/docs/contract-style-guide.md` is the single parent rule for issue 2937 rules.
- A rule that serves the purpose cites `PURPOSE-HIGHEST-SAFE-AUTONOMY` and does not restate it.

## Consequences

A new gate or operator requirement names one reason: quality, safety, or a decision tooling cannot make. A citation audit of existing rules follows in issue 2941.
