### Changed

- The pre-push delta review widens surface hints to the gate round angles, lists stale-surface hits, and refuses `locally_clear` for unaddressed hits (#2740)
- `loop pre-push-delta` now refuses an act-list input run without `--findings-log <the reviewed gate round's findings log>`; the fixer's emitted `handbackCheck` passes the new `--handback` flag instead (#2740)
