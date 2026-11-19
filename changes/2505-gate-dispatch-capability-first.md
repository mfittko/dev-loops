### Fixed

- The gate coordinator now checks for its dispatch tool (`Agent` on Claude Code, `subagent` on Pi) as step 0 and returns `FANOUT_UNAVAILABLE` at once when it is absent, before validation, context building and the emitter; the contract also pins the Claude Code gate topology to a depth that keeps the `Agent` tool (#2505)
