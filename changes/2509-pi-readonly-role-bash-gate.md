### Fixed
- On Pi, the judge and reviewer roles no longer get unrestricted `bash`: a `tool_call` handler reads the dispatch role marker `DEVLOOPS_AGENT_TYPE` and denies everything except the sanctioned pull line (judge) or the pull line plus shell-inert read and search commands (reviewer) (#2509)
