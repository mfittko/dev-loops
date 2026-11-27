### Changed

- `emit-fanout-dispatch.mjs --pending` drops units whose angles all have a terminal artifact at the head that is newer than the gate context file, and keeps their original execution identity in the persisted plan. When every pending unit is dropped the run refuses, restores the prior plan and points to fan-in (#3661)
