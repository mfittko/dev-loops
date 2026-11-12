---
description: "Start a dev loop on a GitHub issue."
argument-hint: "<issue>"
---
<!-- GENERATED from commands/loop-start.command.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->

Run the `dev-loop` skill with the public intent `start dev loop on issue $ARGUMENTS`. Resolve authoritative state first, then route through the deterministic internal strategy. Do not pick an internal strategy name yourself. The main session dispatches the `dev-loops:dev-loop` coordinator (`dev-loop` inside the dev-loops repo itself) to run it. The main session runs no gate, fixer or reviewer step. Before the initial dispatch the main session runs `dev-loops-run cli/index.mjs gate resolve-role --role dev-loop --harness claude` and passes the printed `model` as the Agent `model` parameter only when it is non-null.
