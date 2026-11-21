### Changed

- `gh` calls from every local dev-loops process are paced through a shared machine-wide throttle (`queue.ghMinIntervalMs`, default 500, 0 disables). A secondary rate limit backs off once and retries; a second one fails with `RATE_LIMITED` (#3340)
