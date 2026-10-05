### Fixed
- Playwright config test and `test:playwright:*` scripts resolve the Playwright CLI without a cwd-relative `node_modules/` path, so they pass in a worktree without `node_modules` (#2632)
