### Added

- A clean base merge that edits a file the PR also changed records `partial_carry` when the PR's own hunks are unchanged, so only the angles for that file re-run (#3284)
- A base merge with conflict-resolution hunks records `resolution_delta`: the angles that meet the resolution files and the PR files changed since the last verdict re-run, and the plan lists `resolutionDeltaPaths`, which the re-run reviewers receive as a resolution scope (#3284)
