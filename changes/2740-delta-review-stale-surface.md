### Changed

- The pre-push delta review widens surface hints to the gate round angles, lists stale-surface hits, and refuses `locally_clear` for unaddressed hits (#2740)
- `loop pre-push-delta` refuses an act-list input run without `--findings-log`; the fixer's `handbackCheck` now passes `--handback` instead (#2740)
