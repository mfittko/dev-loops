### Fixed

- `upsert-checkpoint-verdict` ticks verified rows after all refusal checks and leaves unticked any row an open act item names (by label or `ac:<n>` / `dod:<n>` id); `edit-pr` refuses a body that unticks or removes checked rows without `--allow-untick` (#2898)
