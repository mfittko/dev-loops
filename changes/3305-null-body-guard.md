### Fixed

- `edit-pr`, `edit-comment` and `create-pr` refuse a literal `null` body; `--allow-empty-body` overrides the guard and is not forwarded to `gh` (#3305)
