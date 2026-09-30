### Fixed
- The coordinator and main-agent write guards classify a file by its containing repository, so edits in a loop worktree are no longer allowed by default (#2539)
- With `DEVLOOPS_MAIN_AGENT_READONLY=1` or `DEVLOOPS_COORDINATOR_READONLY=1`, the guards also deny tracked files of other repositories and paths inside a git directory (#2539)
- Under `DEVLOOPS_MAIN_AGENT_READONLY=1`, worker agents keep write access to tracked files in a linked worktree (#2539)
