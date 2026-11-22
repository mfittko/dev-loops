### Added

- A local lint, `scripts/loop/check-spawn-timeout.mjs --base <ref>`, flags a `runChild`, `spawnSync` or `execFileSync` call under `scripts/` or `packages/` that a diff touches without an effective timeout option, and the I1 developer checklist line names it. Other spawn forms (`spawn`, `execFile`, `execSync`, `runCommand`) keep the manual timeout duty (#3406)
