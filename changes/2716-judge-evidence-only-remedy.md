### Fixed
- A `valid_compliant` judge decision with `remedyKind: "evidence_only"` needs no `defectClass` or `siteQuery` and never reaches the fixer act list; the judge can run `check-judge-decision.mjs` on its decision file, and a malformed decision fails with a typed error naming the decision and field (#2716)
