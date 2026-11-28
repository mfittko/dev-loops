### Changed

- The `--timeout-ms` flag is removed from the CI probe, Copilot probe, PR checks wait, gate unit wait and initial Copilot PR watch scripts; use `--timeout <seconds>` (#3475)
- The `--pr-body-fix-retry` flag of the fresh review context check is removed; use `--same-head-retry` (#3475)
- The `record-dispatch-prompt-layout.mjs` command line is removed; the fan-out dispatch emitter records the prompt layout itself (#3475)
