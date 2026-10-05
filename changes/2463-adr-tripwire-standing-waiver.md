### Added

- `dev-loops pr edit` routes to `edit-pr.mjs`, and `dev-loops queue remove` removes one mistaken board item (#2463)
- `dev-loops pr waive-adr-tripwire` writes a head-pinned ADR tripwire waiver under an operator-recorded standing authorization (#2463)
- `edit-pr.mjs` and `create-pr.mjs` refuse a body that adds, changes or removes an `adr-tripwire:allow` line (#2463)
- A PR that changes the `.devloops` `standingAuthorizations` block needs a decision record and a fresh owner approval to leave draft (#2463)
- `create-pr.mjs` and `edit-pr.mjs` refuse bypass flags without a checked body and forward that body inline (#2463)
