### Fixed

- New worktrees from ensure-worktree get their own `bun install --frozen-lockfile` (fail-soft, reported as `deps`), and gate depState checks the worktree's own install (#2535)
