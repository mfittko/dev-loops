### Added

- `dev-loops pr edit` routes to `edit-pr.mjs`, and `dev-loops queue remove` removes one mistaken board item (#2463)
- `dev-loops pr waive-adr-tripwire` writes a head-pinned ADR tripwire waiver under an operator-recorded standing authorization (#2463)
- `edit-pr.mjs` and `create-pr.mjs` refuse a body that adds, changes or removes an `adr-tripwire:allow` line (#2463)
- A PR that changes the `.devloops` `standingAuthorizations` block needs a decision record and a fresh owner approval to leave draft (#2463)
- `edit-issue.mjs` refuses a body write that adds, changes or removes an `adr-tripwire:allow` line (#2463)
- `create-pr.mjs` refuses --fill*/--template without --body/--body-file and --recover/--editor/--web always; it and `edit-pr.mjs` forward the checked body inline (#2463)
