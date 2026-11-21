### Changed

- `gh` calls are paced by a shared throttle per main checkout (`queue.ghMinIntervalMs`, default 500, maximum 10000, 0 disables). Separate clones do not share pacing, and a process outside a git checkout fails closed with `GH_THROTTLE_UNAVAILABLE`. Only a `gh` attested as a stub (`DEV_LOOPS_GH_STUB`) is unpaced. A secondary rate limit backs off once, then fails with `RATE_LIMITED`, in `ghJson`, `ghGraphql`, `ghExecFileSync` and the direct async sites that capture gh stderr. `create-pr`, `gh run watch` and the release approval script are paced only (#3340)
