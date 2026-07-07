---
description: "Continue the dev loop — the current in-progress board item, or a given issue/PR."
argument-hint: "[issue|pr]"
---
<!-- GENERATED from commands/loop-continue.command.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->

Continue a dev loop. Two forms, both handed to the `dev-loop` skill — do NOT pick an internal strategy yourself.

- With an argument (`$ARGUMENTS` is an issue or PR — `123`, `#123`, or a GitHub URL): run the `dev-loop` skill with the public intent `continue dev loop on $ARGUMENTS`. Resolve that artifact's authoritative state first, then route; ignore board position.

- Bare (no `$ARGUMENTS`): resolve the single continue target from the board, per
  `QUEUE-LIVE-PICKUP-SOURCE` (owned by `docs/projects-queue-contract.md`). Resolve the board's repo and project the same way the queue commands do, then run `node scripts/projects/resolve-active-board-item.mjs --repo <owner/name> --project <number>`. It continues the single **In Progress** item; if there is none, it picks the **HEAD of Next Up by position**. It fails closed (idle) when Next Up is empty (`QUEUE-NEXTUP-EMPTY-FAIL-CLOSED`), and still fails closed on multiple In-Progress items. It never pulls from Backlog.
  - It returns `{ ok: true, target: { kind, number }, source }` (`source` is `"in-progress"` or `"next-up"`) → run the `dev-loop` skill with the public intent `continue dev loop on #<number>` (the resolved `target.number`), so the intent carries the concrete target instead of re-resolving board state.
  - It returns `{ ok: false, reason }` when there are multiple in-progress items, or when there is nothing in progress **and** Next Up is empty → FAIL CLOSED: print the reason verbatim and instruct the user to run `/loop-continue #N` explicitly (or prioritize a Backlog item into Next Up). Do NOT guess, and never pick from Backlog.

Resolve authoritative state before routing. All paths terminate in the dev-loop skill's `loop startup` → build-envelope → route, stopping at the human-approval checkpoint as usual. No new routing logic here.
