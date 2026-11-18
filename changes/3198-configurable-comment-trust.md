### Changed

- `.devloops` accepts a `trust` block (`githubActionsBot`, `reviewers`), read from the local default-branch ref, to trust review apps and opt out of Actions bot trust (#3198)
- A script that reads trust-filtered text now needs a resolvable `origin/HEAD` and a local `origin/<default branch>` ref; without them it refuses with exit 3 and names the fix, `git remote set-head origin --auto` or `git fetch origin` (#3198)
