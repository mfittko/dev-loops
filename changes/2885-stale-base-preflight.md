### Changed

- A stale base is detected before validation, push and gate dispatch: `pre-write-remote-freshness-guard.mjs --base <name>` and `write-gate-context --base` refuse with `base_stale_integrate_first` and name the merge-and-recheck remedy (#2885)
