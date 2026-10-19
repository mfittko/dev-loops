### Added

- `emit-coordinator-work-order --input <resolver-output.json> --harness <claude or pi> --entry <queue or direct>` prints a compact pull-pointer dispatch payload (#2483)
- The `c` coordinator execution identity prefix is recorded in ADR 0164, which amends ADR 0115 (#2483)
- The `subagent dev-loop` contract row emits the coordinator work order for resumed queue and direct entries (#2483)
