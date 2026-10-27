### Fixed

- `upsert-checkpoint-verdict` now ticks reviewer-verified AC/DoD rows only after every refusal check and skips rows an open judge act item names; `edit-pr` refuses a body that unticks checked rows unless `--allow-untick` is passed (#2898)
