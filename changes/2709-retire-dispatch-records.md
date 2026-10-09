### Fixed

- Gate-round retirement archives matching dispatch-prompt records so fresh same-head reviews do not inherit retired bindings (#2709)
- Rebuilt retired rounds require complete canonical execution inventories, keyed plans, current-gate records and execution-bound original pull receipts before fan-in (#2709)
- Reviewer semantic digests bind execution identity, preventing old delivery receipts from aliasing new canonical emissions (#2709)
- Retirement guards normalize programmatic gates and accept valid fresh same-bucket or lower-filesystem-time evidence without weakening existing post-pull result checks (#2709)
- Fan-in isolates known foreign-gate retirement proof and refuses abbreviated aliases of matching dispatch-retired full heads while retaining unrelated offline inputs (#2709)
- Cross-checkout digest equality applies to the same execution-bound semantic work order, not separate reviewer emissions (#2709)
- Fan-in follows producer-accepted retirement-head directory symlinks, retaining the fresh-dispatch floor and failing closed on broken or unreadable matching targets (#2709)
- Only the chmod-based unreadable test records a root-only skip; exact unprivileged EACCES/output assertions and all other retirement safeguards remain active (#2709)
