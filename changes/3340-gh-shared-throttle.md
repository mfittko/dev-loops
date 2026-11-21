### Changed

- `gh` calls are paced per main checkout (`queue.ghMinIntervalMs`, max 10000). A secondary limit (read from gh stderr) backs off once, including on the default `runChild` and `runCommand`, then fails `RATE_LIMITED`, except paced-only sites (ADR 0305) (#3340)
