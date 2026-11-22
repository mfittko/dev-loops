### Added

- `dev-loops gate runbook` prints a generated gate round runbook for the gate coordinator. It lists the ordered commands with their flags, the wave dispatch and `--timeout` join, the stop conditions and the typed result, each with its rule IDs. The generator fails closed with a `recovery` field when the gate contract or a named rule marker is missing. The gate coordinator and dev-loop agent definitions name the command in place of the relative contract link (#3096)
