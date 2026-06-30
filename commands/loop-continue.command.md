---
description: Continue the dev loop — the current in-progress board item, or a given issue/PR.
argument-hint: "[issue|pr]"
---
Continue a dev loop. Two forms, both handed to the `dev-loop` skill — do NOT pick an internal strategy yourself.

- With an argument (`$ARGUMENTS` is an issue or PR — `123`, `#123`, or a GitHub URL): run the `dev-loop` skill with the public intent `continue dev loop on $ARGUMENTS`. Resolve that artifact's authoritative state first, then route; ignore board position.

- Bare (no `$ARGUMENTS`): pick up the single in-progress board item. Resolve the board's repo and project the same way the queue commands do, then run `node scripts/projects/resolve-active-board-item.mjs --repo <owner/name> --project <number>`.
  - It returns `{ ok: true, target: { kind, number } }` for exactly one in-progress item → run the `dev-loop` skill with the public intent `continue dev loop on #<number>` (the resolved `target.number`), so the intent carries the concrete target instead of re-resolving board state.
  - It returns `{ ok: false, reason }` when there are zero or more than one in-progress items → FAIL CLOSED: print the reason verbatim (it lists the items) and instruct the user to run `/loop-continue #N` explicitly. Do NOT guess.

Resolve authoritative state before routing. All paths terminate in the dev-loop skill's `loop startup` → build-envelope → route, stopping at the human-approval checkpoint as usual. No new routing logic here.
