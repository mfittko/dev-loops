### Fixed
- Bounded waits cap one invocation at about 170 s and return `outcome: "pending"` with a runnable `reissue` command, so Claude Code no longer moves a wait to the background at 180 s (#3099)
