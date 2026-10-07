# 0127. Act-item remediation names the defect class and sweeps every site

## Status

Accepted — 2026-10-07 ([PR 2684](https://github.com/mfittko/dev-loops/pull/2684))

## Context

Amends [0060](./0060-immutable-spec-authority.md): spec authority still decides whether an act item is valid and compliant, as 0060 defines. This record only adds what an authorized remediation must carry and how its coverage is checked. Record 0060 stays unedited.

A fixer that repaired only the named site left same-class sites behind. The next gate round flagged the same surface again, and the loop repeated without a bound. See [issue 2556](https://github.com/mfittko/dev-loops/issues/2556).

## Decision

Three rules in `skills/docs/gate-review-sub-loop-contract.md`, `skills/docs/pre-pr-review-contract.md` and `skills/docs/spec-authority-contract.md` change the remediation path.

- `GATE-EXEC-REMEDIATION-SITE-QUERY`: a `valid_compliant` act item's `authorizedRemediation` names a `defectClass` and a `siteQuery`. The fixer sweeps every site that the query returns. Each site is fixed or recorded with a skip reason.
- `PRE-PUSH-DELTA-RESIDUE`: the pre-push delta review reports same-class residue as a finding that blocks `locally_clear` unless it carries the recorded skip reason.
- `GATE-EXEC-RECURRENCE-ESCALATION`: a surface key `(file, symbol)` that recurs in 3 or more gate rounds escalates to the human checkpoint. The count is computed at judge time and no counter is persisted.

Rejected alternative: keep remediation as free text and rely on repeated gate rounds to find the remaining sites (the status quo, which spends rounds and reviewer budget on one defect class).

## Consequences

A fix covers its defect class in one commit, so fewer rounds re-flag the same surface. A surface that still recurs reaches the operator as a design or split decision instead of looping.
