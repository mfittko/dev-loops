# Implementation workflow

This file is optional. The primary execution entrypoint is the `dev-loop` skill.

Use this file for repo-specific workflow notes that complement the skill.

## Defaults

- one phase at a time
- [Project Plan](../../../PLAN.md) holds roadmap/product truth
- `docs/phases/phase-<n>.md` holds the durable plan for the active phase
- `tmp/phases/phase-<n>/` holds temporary local execution artifacts, reviews, and logs
- fan-out / fan-in / review / merge before coding
- test-first
- deterministic tmp logging
- local validation before phase completion
- local branches and small commits only after verification
