### Fixed

- `edit-pr`, `edit-comment` and `create-pr` refuse an empty, whitespace-only or literal `null` body (`create-pr` now also refuses an empty inline `--body ""`); `--allow-empty-body` overrides the guard and is not forwarded to `gh` (#3305)
