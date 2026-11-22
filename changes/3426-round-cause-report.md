### Added

- Each gate findings-log round records its `roundCause` (`first`, `developer_findings`, `system_rerun`, `base_refresh`, `body_only` or `other_head_move`), and `dev-loops loop round-causes` reports rounds and filed issues per merge, plus the round-1 `draft_gate` findings split by developer-checklist coverage before and after 2026-11-21T17:03Z (a finding counts as covered when its angle has a developer-checklist id in the resolved `gates.draft.angles` config) (#3426)
