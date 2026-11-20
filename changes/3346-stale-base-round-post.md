### Fixed

- `upsert-verdict` posts a clean `draft_gate` or `pre_approval_gate` verdict with a visible `Base freshness: stale` line when only the base moved during the round, instead of refusing it (#3346)
- `loop gate-coordination` routes a stale head to `resolve_merge_conflicts` before `mark_ready_for_review`, `await_final_human_approval` and `declare_merge_ready`, so a verdict posted with the stale-base line never reaches ready or merge without a base merge (ADR 0295, #3346)
