### Changed

- The Pi read-only role gate reads the pi-subagents `active_agent` prompt tag, so dispatched judge and review children are gated; the env marker is removed (#2582)
- The dev-loops extension registers itself as a required child extension, so a foreground judge or reviewer child loads the gate and its `tool_call` handler runs (#2582)
- A read-only Pi session keeps the extension's mutation-capable post-merge hooks inert, so a reviewer's quoted merge text in an allowed read form cannot queue post-merge updates (#2582)
- The default container image pins `pi-subagents` at 0.75.0, the mandatory-runner floor for the required-child-extension registration API (#2582)
