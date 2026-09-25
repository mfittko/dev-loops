### Fixed

- `merge-pr.mjs` now fast-forwards the main checkout, removes the merged branch's worktree, and runs `postMerge.actions` after a merge (#2207)
