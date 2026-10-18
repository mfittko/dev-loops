### Fixed

- `emit-fixer-work-order.mjs --completion-only` re-enters a full fixer plan with a missing or stale disposition handoff as a delivery-only `operation: complete` order, and the completion text lists numbered push, confirm-remote-head and `--construct` steps (#2787)
