---
description: Run a structured Socratic Q&A grill session against an issue or plan file before the dev loop starts.
argument-hint: "<issue-number> | <path/to/plan.md> [--auto]"
---
Invoke the `loop-grill` skill with `$ARGUMENTS`. Parse the argument list before acting:

1. **Argument parsing (fail-closed):**
   - If `$ARGUMENTS` is empty, print `Error: missing argument — provide an issue number or a path to a plan file.` and stop without mutating anything.
   - Split `$ARGUMENTS` into tokens. The first token is the target (`<issue-number>` or `<path/to/plan.md>`). Remaining tokens may include `--auto`. Any other flag produces `Error: unrecognised flag '<flag>' — only --auto is supported.` and stops.
   - If the first token looks like an integer, treat it as a tracker-first issue number. Verify the issue exists via `node scripts/github/list-issues.mjs --repo <owner/repo> --state all --limit 1` filtered to that number; if not found, print `Error: issue #<n> not found.` and stop.
   - If the first token is a path, resolve it relative to the repo root (or as absolute). If the file does not exist, print `Error: plan file not found: <path>` and stop.

2. **Route to the `loop-grill` skill**, passing the resolved target and the `--auto` flag (if present). The skill owns all grilling logic: gap detection, interactive Q&A or auto-answer, write-back, and verdict emission.

> **Note:** Interactive mode uses `AskUserQuestion` for bounded-choice gaps and plain text turns for open-ended gaps. `AskUserQuestion` is a Claude Code–native construct; use `--auto` as the portable fallback when running outside Claude Code.
