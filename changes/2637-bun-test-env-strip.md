### Fixed

- `scripts/run-bun-test.mjs` strips every async-context marker and the Claude harness marker from the env of the spawned `bun test` child, so local runs match CI (#2637)
