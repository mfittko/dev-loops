### Added

- `scripts/loop/check-spawn-timeout.mjs --base <ref>` lints a `runChild`, `spawnSync` or `execFileSync` call that a diff touches without a timeout option; other spawn forms stay manual (#3406)
