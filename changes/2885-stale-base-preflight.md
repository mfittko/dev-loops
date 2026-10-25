### Changed

- A stale base now fails fast with `base_stale_integrate_first` in `write-gate-context --base` and `pre-write-remote-freshness-guard --base`; `--base` accepts `main`, `origin/main`, `refs/heads/main` and `refs/remotes/origin/main`, fetches with a bounded, prompt-free `git fetch origin`, fails with `base_fetch_failed`, and `write-gate-context` records `baseFreshness` (#2885)
