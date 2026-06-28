---
description: Show the read-only dev-loop state summary for an issue or PR.
argument-hint: <issue|pr>
---
Resolve the read-only dev-loop state for `$ARGUMENTS` via the `loop info` shortcut — no full dev-loop run. If `$ARGUMENTS` is an issue number, run `node <dev-loops-package-root>/cli/index.mjs loop info --issue $ARGUMENTS`; if it is a PR number, run `node <dev-loops-package-root>/cli/index.mjs loop info --pr $ARGUMENTS`. Report the strategy, route, linked PR / branch, CI, and next action. Do not start implementation.
