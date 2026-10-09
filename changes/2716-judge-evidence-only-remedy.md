### Fixed
- A `valid_compliant` judge decision with `remedyKind: "evidence_only"` needs no `defectClass` or `siteQuery` and skips the fixer act list; `check-judge-decision.mjs` validates a decision file (#2716)
