### Fixed

- `comment-issue.mjs` and `edit-comment.mjs` refuse a body line that opens with `approve merge` or `adr-tripwire:allow`, so an agent cannot write the operator-owned merge approval or ADR tripwire waiver through a comment (#2695)
