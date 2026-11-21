### Added

- A clean base merge that edits a file the PR also changed records `partial_carry` when the PR's own hunks are unchanged, so only the angles for that file re-run (#3284)
- A base merge with conflict resolutions records `resolution_delta`, and re-run reviewers receive the plan's `resolutionDeltaPaths` as a resolution scope and the other re-run files (`resolutionDeltaFullPaths`) for full PR-hunk review (#3284)
