---
description: Show the dev-loop queue board grouped by column.
argument-hint: ""
---
Show the dev-loop queue board. Takes no arguments; if `$ARGUMENTS` is non-empty, ignore it. `<owner/repo>` resolves from the git remote at invocation, same as the other loop commands, and the project is auto-resolved from `.devloops` — never pass `--project`.

1. Run `node scripts/projects/list-queue-items.mjs --repo <owner/repo> --summary`. This is the sanctioned grouped-by-column path: it emits `{ ok, groups: { "<Status>": { count, items } } }` in board column order. Do not re-implement client-side grouping and do not pipe flat output through inline parsers.

2. Render the result human-readably (not raw JSON). Walk `groups` in the order they are returned (board column order — Backlog, Next Up, In Progress, Done). For each column, print the column name with its count, then one line per item as `#<number> <title>`. Example:

   ```
   Backlog (2)
     #1035 Add loop-enqueue and loop-queue-status commands
     #1042 Fix article layout
   Next Up (0)
   In Progress (1)
     #1041 Align nav/wrap/prose widths
   Done (3)
     ...
   ```

3. If every column is empty (all counts `0`), print `Queue is empty.` instead of a list.
