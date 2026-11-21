### Fixed

- A delta residue with no site (a blank or whitespace `site` counts as siteless, so it no longer matches a recorded empty `input_form` skip) clears on a PR body edit after the sealed result or on a `sitelessSkipReason`; `noSitesReason` does not clear it (#3364)
- The emitted fixer `handbackCheck` now passes `--repo` and `--pr`, and the coordinator input run falls back to the fixer plan target; an explicit `--repo`/`--pr` that differs from the authenticated plan target is refused, and the sealed repo compares case-insensitively (#3364)
