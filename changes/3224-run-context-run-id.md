### Fixed

- A Claude Code lane keeps its PR runner claim with no `DEVLOOPS_RUN_ID`: `loop startup --claim` persists the run id in the worktree (#3224)
- `gate wait-for-units` heartbeats the PR runner claim during a long wait, and `loop runner-coordination` routes the claim helper (#3224)
