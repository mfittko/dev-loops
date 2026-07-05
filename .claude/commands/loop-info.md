---
description: "Show the read-only dev-loop state summary for an issue or PR."
argument-hint: "<issue|pr>"
---
<!-- GENERATED from commands/loop-info.command.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->

Resolve the read-only dev-loop state for `$ARGUMENTS` via the `loop info` shortcut — no full dev-loop run. If `$ARGUMENTS` is an issue number, run `npx dev-loops@0.7.0 loop info --issue $ARGUMENTS`; if it is a PR number, run `npx dev-loops@0.7.0 loop info --pr $ARGUMENTS`. Report the strategy, route, linked PR / branch, CI, and next action. Do not start implementation.
