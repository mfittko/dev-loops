### Fixed

- In a managed repo, the Claude Bash hook denies raw `gh pr edit` and `gh api` body writes to `pulls/<n>` and `issues/<n>` for every actor, including `--input` and graphql `updatePullRequest` (#3031)
- In a managed repo, Claude Code's Bash hook now denies any `timeout N <sanctioned dev-loops command>` wrapper, for every actor (#3031)
- In a managed repo the Claude hook denies the whole command holding gh, pr, edit or create and a body flag, in any order, fail closed (#3031)
