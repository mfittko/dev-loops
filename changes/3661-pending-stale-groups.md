### Changed

- `emit-fanout-dispatch.mjs --pending` drops units whose angles already finished at the head when the gate context is older than the prior emit plan, and keeps their original execution identity in the persisted plan (#3661)
