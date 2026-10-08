### Changed
- `merge-pr` now enforces the ADR tripwire at the PR head on every merge class and re-issues a stale standing waiver through `waive-adr-tripwire`. The waiver writer also accepts a clean current-head `pre_approval_gate` verdict (#2682)
