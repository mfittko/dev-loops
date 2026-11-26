### Changed

- A `draft_gate` round now runs at a stale base. Only `pre_approval_gate` and `merge-pr` require a head that contains `origin/<base>` (#3571)
