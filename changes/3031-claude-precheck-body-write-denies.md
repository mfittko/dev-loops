### Fixed

- In a managed repo, the Claude Bash hook denies raw `gh pr edit` and `gh api` body writes to `pulls/<n>` and `issues/<n>` for every actor, including `--input` and graphql `updatePullRequest` (#3031)
- In a managed repo, the Claude Bash hook denies a command that holds a brace word with more than 64 expansions (fails closed), even without a gh token (#3031)
- In a managed repo, Claude Code's Bash hook now denies any `timeout N <sanctioned dev-loops command>` wrapper, for every actor (#3031)
- The Claude hook denies a command with gh, pr, edit or create and a body flag; gh, api and a body field or --input; or gh, api, graphql and a mutation or body token, in any order (#3031)
