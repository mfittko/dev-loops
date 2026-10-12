### Changed

- The pre-push delta review widens surface hints to the gate round angles, lists stale-surface hits, and refuses `locally_clear` for unaddressed hits (#2740)
- Only the full-phase fixer may push a delta candidate; `check-pre-push-delta --pr-head` fails closed when the PR head moved (#2740)
