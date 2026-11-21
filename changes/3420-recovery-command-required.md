### Added
- `RECOVERY-COMMAND-REQUIRED` rule and a CI ratchet check over `ok: false` refusals in five roots; CI fails on any per-file count that differs from the committed baseline, and the local run rewrites a fallen count for commit (#3420)
