### Changed
- The secret scan now uses `@secretlint/core` instead of home-built heuristics, and `merge-pr.mjs` refuses a merge whose diff adds a detected secret (#1858)
