# AGENTS.md

## Project contract

This repository uses the `dev-loop` skill as the primary implementation workflow.

The skill may be provided repo-locally or globally; this contract does not assume a local skill path.

## Working agreement

- Work test-first for all non-trivial logic.
- Maintain at least 90% coverage for lines, statements, functions, and branches.
- Implement one phase at a time.
- Use fan-out / fan-in / review / merge before implementing each phase.
- Keep logs under `tmp/` in deterministic phase-scoped paths.
- Use local branches and small commits only after local verification.
- Do not assume GitHub PR or issue workflows.

## Core guard rails

- KISS
- SRP
- YAGNI
- strict TypeScript
- thin runtime glue
- no production reliance on Pi private internals
