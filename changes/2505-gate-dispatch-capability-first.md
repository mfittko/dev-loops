### Fixed

- The gate coordinator checks for its dispatch tool first and returns `FANOUT_UNAVAILABLE` before validation when it is absent; the gate coordinator runs at a depth that keeps the `Agent` tool (#2505)
