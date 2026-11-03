### Changed

- The Bash gate denies any subagent role that runs `scripts/github/merge-pr.mjs` without `--check`; the top-level session keeps the script (#2500)
- The dev-loop skill and handoff contract state that a coordinator hands back the `--check` result and the merge command line, and a brief has no merge step (#2500)
