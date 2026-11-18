### Changed

- `.devloops` accepts a `trust` block (`githubActionsBot`, `reviewers`), read only from the local default-branch ref with no `git fetch`, to trust review apps and opt out of the GitHub Actions bot trust; a `trust.reviewers` login is a trusted author on every gate-evidence surface (#3198)
