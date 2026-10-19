### Added

- `emit-coordinator-work-order --input <resolver-output.json> --harness <claude or pi> --entry <queue or direct>` prints a compact pull-pointer dispatch payload (#2483)
- The `c` coordinator execution identity prefix is recorded in ADR 0164, which amends ADR 0115 (#2483)
- The `subagent dev-loop` row in the main-agent contract tells the orchestrator to emit the coordinator work order from the startup-output path named in the coordinator hand-back, for resumed queue and direct entries, and dispatch the printed payload unchanged (#2483)
