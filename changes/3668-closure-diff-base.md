### Fixed

- A closure round's diff starts at the previous round head merged with the current base, so a base merge since that head adds no hunk to the PR-own files' diff (#3668)
