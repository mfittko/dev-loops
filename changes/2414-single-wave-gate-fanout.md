### Changed

- Gate fan-out releases its first reviewer wave immediately; the mandatory cache primer and lead-reviewer wait are gone, and priming is an optional adapter optimization (#2414)
- A reviewer unit and the `gates.fanout.maxAnglesPerGroup` default now hold up to 5 angles, and `holistic` joins the leftover pool instead of its own unit (#2414)
- `consolidate-fanin.mjs` no longer accepts `--primer-evidence` or `--primer-plan`; the `@dev-loops/core/loop/primer-evidence` export is removed (#2414)
