# 0052. Fail-closed ADR tripwire for decision-shaped PRs

## Status

Accepted — 2026-08-30 ([issue 1867](https://github.com/mfittko/dev-loops/issues/1867))

Enforces the presence half of [ADR-WORTHY-PERSIST](../../skills/docs/decision-record-contract.md) for a bounded set of mechanically detectable surfaces. The ADR-shape contract (numbering, sections, status, supersede-not-rewrite) and its validator are unchanged.

## Context

`ADR-WORTHY-PERSIST` is an RFC-2119 MUST, but its enforcement was advisory-only: no detector or test checked that an ADR was actually produced, and `scripts/docs/validate-decision-records.mjs` validates only the shape of records that already exist. A PR embedding a policy-level decision could merge through the full gate with no ADR, resting entirely on a reviewer noticing. Deciding what is "ADR-worthy" is judgment-heavy, so a complete deterministic detector is not feasible — but the highest-signal cases are mechanically detectable.

## Decision

A cheap fail-closed tripwire, not a classifier. `scripts/loop/check-adr-tripwire.mjs` blocks any PR whose diff touches a decision-shaped surface — a `skills/docs/*-contract.md` file, the shared gate config `packages/core/src/config/extension-defaults.yaml`, or a rule-modality (MUST/SHALL vs SHOULD vs MAY family) reversal on an existing `<!-- rule: <ID> -->` (including a keyword stripped from a rule that keeps its marker, or a rule removed outright from a still-present rule-bearing doc) — unless the same diff adds or updates a `docs/decisions/NNNN-*.md` record, or the PR body carries a one-line waiver `adr-tripwire:allow <reason>` (mirroring `secret-scan:allow`'s marker-plus-reason shape, anchored to line start; both enforcement paths honor it identically without a flag surface, and a bare marker or a mid-sentence mention does not waive). A changed rule-bearing doc whose base and head content cannot both be read fails closed (unresolvable-rule-scan), and a deleted decision record never counts as ADR presence. We rejected a general ADR-worthiness classifier (not deterministically feasible) and a config toggle (a fail-open escape hatch the issue does not ask for); the ADR-file-or-waiver requirement is the only configuration the tripwire needs.

## Consequences

The highest-signal ADR-worthy changes convert from advisory to fail-closed; false positives on contract-doc prose edits are accepted friction, discharged by adding the (fittingly required) ADR or the waiver. Rule-modality extraction is lexical and bounded (marker line plus a short following window), so subtle rewording that hides a reversal from the scan remains reviewer territory — accepted, since the tripwire is a floor, not a ceiling. The tripwire applies to its own enabling PR, which carries this record.
