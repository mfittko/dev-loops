### Fixed

- ensure-worktree runs bun install --frozen-lockfile in newly created worktrees (reported as `deps`, fail-soft), and the gate depState reports the worktree's own install instead of the main checkout's (#2535)
