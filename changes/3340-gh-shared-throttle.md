### Changed

- `gh` calls are paced per main checkout (`queue.ghMinIntervalMs`, max 10000). A secondary limit read from stderr backs off once, then fails `RATE_LIMITED` (ADR 0305) (#3340)
