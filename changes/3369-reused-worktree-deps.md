### Fixed
- A reused worktree and a base merge through `resolve-pr-conflicts` now run `bun install --frozen-lockfile` when the lockfile or a workspace `package.json` changed since the last install, and the secret scanner names the missing package and the install command on `ERR_MODULE_NOT_FOUND` (#3369)
