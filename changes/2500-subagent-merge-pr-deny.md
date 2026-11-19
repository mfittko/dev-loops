### Changed

- The Bash gate denies any subagent role a command whose raw text names `merge-pr`, `--check` included; the top-level session keeps the script (#2500)
- The dev-loop skill and handoff contract state that the orchestrator is the only actor that runs `merge-pr.mjs`, and a brief has no merge step (#2500)
