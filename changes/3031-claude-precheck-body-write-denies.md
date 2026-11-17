### Fixed

- Claude Code's Bash hook now denies raw `gh pr edit` and `gh api` body writes to `pulls/<n>`/`issues/<n>` for every actor, covering `--input` and a `gh api graphql` `updatePullRequest` (#3031)
- Claude Code's Bash hook now denies any `timeout N <sanctioned dev-loops command>` wrapper, for every actor (#3031)
- In a managed repo, the Claude body-write deny rejects the whole Bash command when it holds the tokens `gh`, `pr` and `edit` or `create`, plus a body flag (`--body*`, or a short cluster with `b` or `F`), in any order across segments, pipes and wrappers, with no `echo` exemption (fail closed) (#3031)
