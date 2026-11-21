### Added

- A clean base merge that edits a file the PR also changed records `partial_carry` when the PR's own hunks are unchanged, so only the angles that review that file re-run (#3284)
- A base merge with conflict-resolution hunks records `resolution_delta`: the delta review covers the resolution hunks and the other angles carry (#3284)
