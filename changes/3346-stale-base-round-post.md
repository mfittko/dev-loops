### Fixed

- `upsert-verdict` posts a clean `draft_gate` or `pre_approval_gate` verdict with a `Base freshness: stale` line when only the base moved during the round (#3346)
- `loop gate-coordination` routes a stale head to `resolve_merge_conflicts` before the ready flip and final approval (#3346)
