### Fixed

- Gate-round retirement archives matching dispatch-prompt records so fresh same-head reviews do not inherit retired bindings (#2709)
- Rebuilt retired rounds require fresh keyed dispatch plans, complete current-gate records and post-retirement pull receipts before fan-in (#2709)
- Retirement guards normalize programmatic gate identities and combine filesystem ordering with archived-execution rejection, allowing fresh same-bucket dispatch evidence without reopening retired executions (#2709)
