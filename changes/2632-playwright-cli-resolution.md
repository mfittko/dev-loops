### Fixed
- `playwright-config-generation` test and `test:playwright:*` scripts resolve the Playwright CLI without a cwd-relative `node_modules/` path, so they pass from a worktree without its own `node_modules` (#2632)
