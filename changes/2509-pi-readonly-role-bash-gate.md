### Fixed
- On Pi, judge and reviewer roles no longer get unrestricted `bash`: a `tool_call` handler reads `DEVLOOPS_AGENT_TYPE` and denies all but the sanctioned pull line and shell-inert reads (#2509)
