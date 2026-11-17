### Fixed

- In a managed repo, the Claude Bash hook denies raw `gh pr edit` and `gh api` body writes to `pulls/<n>` and `issues/<n>` for every actor, including `--input` and graphql `updatePullRequest` (#3031)
- In a managed repo, Claude Code's Bash hook now denies any `timeout N <sanctioned dev-loops command>` wrapper, for every actor (#3031)
- In a managed repo the Claude hook denies a command holding gh, pr, edit or create and a body flag, or gh, api and a body field or --input, or gh, api, graphql and updatePullRequest, updateIssue or body, in any order; data-only matches are denied too (#3031)
