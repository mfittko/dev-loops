### Changed
- The secret scan uses `@secretlint/core` instead of home-built heuristics, and `merge-pr.mjs` refuses a merge whose diff adds a detected secret (#1858)
- `scanDiffText` from `@dev-loops/core/security/secret-scan` is now async and returns a Promise (#1858)
- Findings and `scan-staged-diff.mjs` `hits[]` entries carry `ruleId` instead of `detectorClass`, and `file` and `line` can be null (#1858)
- `scanLineText`, `shannonEntropy` and `DETECTOR_CLASSES` are removed from `@dev-loops/core/security/secret-scan` (#1858)
