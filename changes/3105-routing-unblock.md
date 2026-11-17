### Fixed

- `loop startup --pr` on a ready PR you own now points at the gate-coordination pre-flight, whatever the PR author (#3105)
- A draft PR with an open draft_gate act list at its head now routes to the fixer instead of another round, a cap-round block or a base integration (#3105)
