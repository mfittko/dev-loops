### Added

- Claude Code coordinators make one `SubagentHandback` per run and pause in plain text; the orchestrator reads the coordinator output file (#2611)
- On Claude Code the dev-loop coordinator never calls `SubagentHandback` while a child is in flight; it pauses in plain text and names each child (#2611)
