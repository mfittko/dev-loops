### Fixed

- `edit-pr`, `edit-comment` and `create-pr` refuse a body of literal `null` through the shared `assertWritableBody` guard in `resolveBodyOrFile`; `--allow-empty-body` (consumed by `create-pr`, never forwarded to `gh`) overrides it (#3305)
