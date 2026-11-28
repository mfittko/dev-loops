### Changed

- From `draft_gate` round 2 on, a `low` cluster floors at `reject` in every round, including at and past the cap, unless the judge sets `lowException` to `unmet_ac`, `regression` or `security`; `GATE-EXEC-LOW-FIX-UNTIL-CAP` is replaced by `GATE-EXEC-LOW-ROUND-FLOOR` and the `low_fix_until_cap` code is now `low_floor` (ADR 0339, #3649)
