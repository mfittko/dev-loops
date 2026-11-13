### Fixed

- Claude Code's Bash hook now denies raw `gh pr edit` and `gh api` body writes to `pulls/<n>`/`issues/<n>` for every actor, covering `--input` and a `gh api graphql` `updatePullRequest` (#3031)
- Claude Code's Bash hook now denies any `timeout N <sanctioned dev-loops command>` wrapper, for every actor (#3031)
- The Claude hook's `gh pr edit` / `gh api` body-write deny reads through a `timeout`/`sudo`/`nice`/`time` or path-prefixed wrapper, a wrapper's own options (`sudo -n`, `nice -n 5`) included (#3031)
