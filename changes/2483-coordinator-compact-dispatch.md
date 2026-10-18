### Added

- `emit-coordinator-work-order --harness --entry` materializes the order and prints a compact pull-pointer dispatch payload for Claude and Pi (#2483)
- The `c` coordinator execution identity prefix is recorded in ADR 0159, which amends ADR 0115 (#2483)
- The `subagent dev-loop` row in the main-agent contract tells the orchestrator to emit the coordinator work order for queue and direct entries and dispatch the printed `dispatchPayload` unchanged (#2483)
