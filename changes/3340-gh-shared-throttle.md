### Changed

- `gh` calls are paced per main checkout (`queue.ghMinIntervalMs`, max 10000). A secondary limit backs off once, then fails `RATE_LIMITED`, except paced-only sites (ADR 0305) (#3340)
