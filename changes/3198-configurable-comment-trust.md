### Changed

- `.devloops` accepts a `trust` block (`githubActionsBot`, `reviewers`), read from the local default-branch ref, to trust review apps and opt out of Actions bot trust (#3198)
- A script that reads trust-filtered text needs `origin/HEAD` and a local `origin/<default branch>`; else it exits 3 naming the fix (#3198)
