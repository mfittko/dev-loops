### Changed

- The Bash gate now denies any subagent role that runs `scripts/github/merge-pr.mjs` without `--check`; the top-level session keeps the script and `--check` stays open to every actor (#2500)
