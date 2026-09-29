### Fixed
- The coordinator and main-agent write guards classify a file by the repository that contains it, so edits in a loop worktree are no longer allowed by default (#2539)
- With `DEVLOOPS_MAIN_AGENT_READONLY=1` or `DEVLOOPS_COORDINATOR_READONLY=1`, the guards also deny tracked files of other git repositories and any path with a `.git` segment (#2539)
