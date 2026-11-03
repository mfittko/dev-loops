### Changed

- The Bash gate now denies any subagent role that runs `scripts/github/merge-pr.mjs` without `--check`; the top-level session keeps the script and `--check` stays open to every actor (#2500)
- The dev-loop skill and the workflow handoff contract state that a coordinator hands back the `merge-pr.mjs --check` result and the exact merge command line, and a brief carries no merge step (#2500)
