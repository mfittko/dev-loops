### Changed

- Wait and probe tools take one flag, `--timeout <seconds>`; `--timeout-ms` is a deprecated alias and both flags together fail closed (#2755)
- Skills no longer prescribe `timeout N` shell wrappers; the Bash gate denies them and `check-retro-tooling` sees through them (#2755)
