# 0136. The judge Bash boundary allows the decision check

## Status

Accepted — 2026-10-09 ([PR 2717](https://github.com/mfittko/dev-loops/pull/2717))

## Context

Amends [0127](./0127-act-item-remediation-names-defect-class-and-sweeps-sites.md): a `valid_compliant` decision with `remedyKind` `evidence_only` needs no `defectClass` or `siteQuery` and does not count toward recurrence escalation. Amends [0115](./0115-dispatch-pointer-carries-the-execution-identity-alone.md): the judge Bash boundary accepted only the sanctioned work-order pull line, so the judge could not validate its own decision before returning it. Amends [0060](./0060-immutable-spec-authority.md): an invalid spec-authority decision had no typed failure. Records 0127, 0115 and 0060 stay unedited.

## Decision

- The judge may also run `check-judge-decision.mjs --file <path>`. The path must lie under `tmp/gate-judge/`, contain no `..` and carry no command chaining. The Claude hook and the Pi read-only gate enforce the same rule.
- A `valid_compliant` decision with `remedyKind: "evidence_only"` needs no `defectClass` or `siteQuery` and never enters the fixer act list.
- The launcher-cwd rule exempts the judge decision-check line.
- A `valid_compliant` decision missing `defectClass` or `siteQuery` fails with the typed error `spec_authority_decision_invalid`.

## Consequences

The judge self-checks its decision file with one extra sanctioned line. Evidence-only items cost the fixer nothing. A `valid_compliant` decision missing `defectClass` or `siteQuery` fails with a name a caller can match.
