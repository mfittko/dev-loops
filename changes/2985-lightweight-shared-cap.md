### Changed
- Lightweight startup eligibility uses the shared light-mode cap (weighted logic LOC, non-doc files, config-source floor) (#2985)
- Lightweight startup counts both endpoints of a rename in the changed-file list (#2985)
- Lightweight startup fails closed with `size_outcome_unavailable` on a missing or failed size capture, a block size outcome or a failed changed-file read (#2985)
- A `--base`-only gate dispatch run resolves `size_outcome_unavailable` (#2985)
