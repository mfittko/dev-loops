### Added

- `dev-loops decision record` posts an operator decision comment (`accept`, `exempt`, `defer`) from the operator's answer file, behind a `permissions.ask` prompt under Claude Code; Pi refuses with `harness_without_permission_prompt` (#3300)
- The Claude Bash hook denies the recorder from any subagent and every spelling other than `dev-loops-run cli/index.mjs decision record`, and `dev-loops status` reports a settings file that allows the recorder or drops its ask rules (#3300)
