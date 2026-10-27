### Fixed

- `upsert-checkpoint-verdict` ticks verified AC/DoD rows only after all refusal checks; `edit-pr` refuses a body that unticks or removes checked rows (flipped, deleted or reworded) without `--allow-untick` (#2898)
