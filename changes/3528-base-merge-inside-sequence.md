### Fixed
- `resolve-pr-conflicts.mjs` refuses the base merge with `base_merge_inside_sequence` while an ungranted gate fix sequence is open at HEAD, and the `head_moved` and `no_commit` closures of `check-pre-push-delta.mjs` carry a `reason` that says the marker is removed and the push of HEAD follows (#3528)
