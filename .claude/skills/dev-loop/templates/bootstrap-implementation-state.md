# Implementation state

## Status

Preparation is in place. Implementation has not started.

## Current source of truth

- Product plan: [Project Plan](../../../PLAN.md)
- Durable phase plans: [Phase Plan](../../../docs/phases/)
- Execution skill: `dev-loop`
- Repo contract: [Agent Instructions](../../../AGENTS.md)
- Workflow explainer: [Implementation Workflow](../../../docs/IMPLEMENTATION_WORKFLOW.md)
- tmp index for fresh-context inspection if present locally: `tmp/phases/index.json`

## Next action for a fresh session

If the user says **"start implementation"**:

1. read [Project Plan](../../../PLAN.md)
2. load the `dev-loop` skill
3. read [Agent Instructions](../../../AGENTS.md) if it exists
4. read [Implementation Workflow](../../../docs/IMPLEMENTATION_WORKFLOW.md)
5. read the current durable phase plan under `docs/phases/` if it exists
6. inspect `tmp/phases/` only if it exists locally and is relevant
7. read this file
8. start with the next unfinished phase only

## Next unfinished phase

Phase 0 — define the workflow convention, durable phase-plan format, and initial package boundary.
