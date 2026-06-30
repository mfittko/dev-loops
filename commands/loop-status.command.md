---
description: Report dev-loop readiness (gh auth, git repo, subagent availability).
---
Report dev-loop readiness for this environment. Check, in one pass: `gh` is installed (`command -v gh`), `gh` is authenticated (`gh auth status`), the working directory is inside a git repo (`git rev-parse --is-inside-work-tree`), and the `subagent`/`Agent` capability is available. Summarize which checks passed and the suggested next step. Read-only — do not start implementation.
