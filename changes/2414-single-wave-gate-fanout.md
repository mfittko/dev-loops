### Changed

- Gate fan-out releases its first reviewer wave immediately; the mandatory cache primer and lead-reviewer wait are gone, and priming is an optional adapter optimization (#2414)
- A reviewer unit and the `gates.fanout.maxAnglesPerGroup` default now hold up to 5 angles, and `holistic` joins the leftover pool instead of its own unit (#2414)
- Every gate round dispatches in one wave: excess units pack into at most `maxConcurrent` units of 5 angles, and a round above capacity is refused (#2414)
- The `gates.fanout.maxConcurrent` default and the Claude fan-out cap rise from 4 to 5, so a full 22-angle draft round fits one wave (#2414)
- `consolidate-fanin.mjs` no longer accepts `--primer-evidence` or `--primer-plan`; the `@dev-loops/core/loop/primer-evidence` export is removed (#2414)
- Repos pinning `maxConcurrent` or `maxAnglesPerGroup` below 5 may get a `GATE-EXEC-FANOUT-CAPACITY` refusal on full rounds; raise `maxConcurrent`, disable angles, or rely on dynamic pruning (#2414)
- A pre-change ledger with no recorded membership whose reviewer shared a 3-angle chunk of a >5-angle group needs a one-time re-gate (#2414)
