### Fixed

- In a managed repo, Claude Code's Bash hook now denies raw `gh pr edit` and `gh api` body writes to `pulls/<n>`/`issues/<n>` for every actor, covering `--input` and a `gh api graphql` `updatePullRequest` (#3031)
- In a managed repo, Claude Code's Bash hook now denies any `timeout N <sanctioned dev-loops command>` wrapper, for every actor (#3031)
- In a managed repo the Claude hook denies the whole command holding gh, pr, edit or create and a body flag, in any order, fail closed (#3031)
