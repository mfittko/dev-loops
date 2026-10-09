### Fixed

- Gate-round retirement archives matching dispatch-prompt records so fresh same-head reviews do not inherit retired bindings (#2709)
- Rebuilt retired rounds require complete canonical execution inventories, keyed plans, current-gate records and execution-bound original pull receipts before fan-in (#2709)
- Reviewer semantic digests bind execution identity, preventing old delivery receipts from aliasing new canonical emissions (#2709)
- Retirement guards normalize programmatic gates and accept valid fresh same-bucket or lower-filesystem-time evidence without weakening existing post-pull result checks (#2709)
