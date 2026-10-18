### Fixed

- ensure-worktree runs `bun install --frozen-lockfile` in a newly created worktree; gate depState reads the worktree's own install (#2535)
