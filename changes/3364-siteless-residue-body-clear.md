### Fixed

- A delta residue with no site clears on a PR body edit after the sealed result or on a `sitelessSkipReason`; `noSitesReason` no longer clears it (#3364)
- The emitted fixer `handbackCheck` now passes `--repo` and `--pr`, and the handback falls back to the fixer plan target (#3364)
