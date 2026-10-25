### Changed

- A stale base now fails fast with `base_stale_integrate_first` in `write-gate-context --base` and the freshness guard; `baseFreshness` is recorded; fetch errors give `base_fetch_failed` (#2885)
