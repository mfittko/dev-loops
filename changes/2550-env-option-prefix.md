### Fixed
- The Bash command guards now see commands behind `env` options such as `env -C <dir>`, so inline-interpreter, `git stash` and `gh pr merge`/`ready` denies fire (#2550)
