### Changed
- Test runs now refuse to start when a worktree resolves its core package from another checkout, and the inline-interpreter hook also blocks `bun -e` and `bun` stdin scripts (#2941)
- The release runbook defines the recurring post-release audit, memory and prose cleanup steps and the combined release retro (#2941)
