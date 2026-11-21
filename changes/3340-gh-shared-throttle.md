### Changed

- `gh` calls are paced by a shared machine-wide throttle (`queue.ghMinIntervalMs`, default 500, 0 disables). A secondary rate limit backs off once, then fails with `RATE_LIMITED` (#3340)
