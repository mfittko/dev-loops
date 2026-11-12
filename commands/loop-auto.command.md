---
description: Run an autonomous dev loop on a GitHub issue until the human approval checkpoint.
argument-hint: <issue>
---
Run the `dev-loop` skill with the public intent `auto dev loop on issue $ARGUMENTS`. Resolve authoritative state first, then continue autonomously through the routed loop until a stop condition or the human approval checkpoint. Do not pick an internal strategy name yourself. The main session dispatches the `dev-loops:dev-loop` coordinator (`dev-loop` inside the dev-loops repo itself) to run it. The main session runs no gate, fixer or reviewer step. Before the initial dispatch the main session runs `dev-loops gate resolve-role --role dev-loop --harness claude` and passes the printed `model` as the Agent `model` parameter only when it is non-null.
