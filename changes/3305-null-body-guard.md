### Fixed

- `edit-pr` and `edit-comment` refuse a body of literal `null` through the shared `assertWritableBody` guard in `resolveBodyOrFile`; `--allow-empty-body` overrides it (#3305)
