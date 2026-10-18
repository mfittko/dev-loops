### Fixed

- ensure-worktree runs its own `bun install --frozen-lockfile` on create and on reuse without a real node_modules (fail-soft `deps` report); gate depState reads that install (#2535)
