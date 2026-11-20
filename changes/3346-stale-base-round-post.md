### Fixed

- `upsert-verdict` posts a clean `draft_gate` or `pre_approval_gate` verdict with a visible `Base freshness: stale` line when only the base moved during the round, instead of refusing it (#3346)
