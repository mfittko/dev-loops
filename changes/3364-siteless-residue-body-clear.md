### Fixed

- A delta residue with a blank or whitespace `site` is siteless. It clears on a PR body edit after the sealed result or on a `sitelessSkipReason`, not on `noSitesReason` (#3364)
- The emitted fixer `handbackCheck` passes `--repo` and `--pr`, and the sealed repo compares case-insensitively. A `--repo`/`--pr` that differs from the plan target is refused (#3364)
