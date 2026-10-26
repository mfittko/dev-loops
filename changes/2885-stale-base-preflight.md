### Changed

- A stale base now fails fast with `base_stale_integrate_first` in `write-gate-context` and the freshness guard. Every gate-context run checks the PR's base branch, with or without `--base`; `baseFreshness` is recorded on every path; fetch errors give `base_fetch_failed` (#2885)
