### Fixed

- **`bun run verify` no longer runs a nested repo-root `worktrees/<name>/` checkout's test copies as this checkout's own (PR [#2250](https://github.com/mfittko/dev-loops/pull/2250)).** `scripts/run-bun-test.mjs` now passes `--path-ignore-patterns=worktrees/**` alongside the existing `tmp/**`, so a primary-checkout verify stops reporting another branch's test failures as its own. A caller-supplied copy of either pattern is still de-duplicated.
