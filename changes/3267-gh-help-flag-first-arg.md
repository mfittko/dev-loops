### Fixed

- The Bash gate treats `-h` or `--help` as a help request only when it is the first argument after the gh verb, so `gh pr merge 42 --squash --body -h` no longer bypasses the merge block (#3267)
