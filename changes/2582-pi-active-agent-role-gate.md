### Changed

- The Pi read-only role gate reads the pi-subagents `active_agent` prompt tag, so dispatched judge and review children are gated; the env marker is removed (#2582)
- The dev-loops extension registers itself as a required child extension, so a foreground judge or reviewer child loads the gate and its `tool_call` handler runs (#2582)
