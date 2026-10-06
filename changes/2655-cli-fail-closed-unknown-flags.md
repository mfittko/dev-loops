### Fixed

- `dev-loops` routed subcommands fail closed on an unknown flag: the CLI no longer re-runs the script with the flag stripped, and returns the script's own exit code and error text (#2655)

### Removed

- The `@dev-loops/core/cli/retry-wrapper` export and its module (#2655)
