### Changed

- `gh` calls are paced per main checkout (`queue.ghMinIntervalMs`, default 500, max 10000). A secondary rate limit backs off once, then fails with `RATE_LIMITED` (#3340)
