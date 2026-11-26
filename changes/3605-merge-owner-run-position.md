### Fixed

- The merge owner Bash-gate deny matches a command that runs the merge script, so a subagent can `grep`, `git grep`, `sed -n` and `git show` the script and its ADRs. Removed: the export `commandMentionsMergePr` of `@dev-loops/core/loop/bash-gate-decisions`; a consumer that imports it fails at module load (#3605)
