### Added

- `emit-coordinator-work-order --input <resolver-output.json> --harness <claude or pi> --entry <queue or direct>` prints a compact pull-pointer dispatch payload (#2483)
- The `c` coordinator execution identity prefix is recorded in ADR 0159, which amends ADR 0115 (#2483)
- The `subagent dev-loop` row in the main-agent contract tells the orchestrator to emit the coordinator work order and dispatch the printed payload unchanged (#2483)
