### Fixed

- ensure-worktree runs `bun install --frozen-lockfile` on create and on reuse unless node_modules holds every bun.lock root dependency; gate depState reads that install (#2535)
