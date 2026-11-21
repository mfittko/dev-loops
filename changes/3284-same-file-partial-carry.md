### Added

- A clean base merge that edits a file the PR also changed records `partial_carry` when the PR's own hunks are unchanged, so only the angles for that file re-run (#3284)
- A base merge with conflict resolutions records `resolution_delta`; re-run reviewers get `resolutionDeltaPaths` as the resolution scope and `resolutionDeltaFullPaths` for full review (#3284)
