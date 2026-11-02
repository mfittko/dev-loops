### Added
- `merge-pr.mjs --check` reports the merge class, the exact `approve merge <headSha>` line and every failing precondition without merging (#2500)
- A merged PR gets a record comment naming the approval path, approver and head SHA, and a later PENDING review draft no longer hides an earlier APPROVED review from the merge gate (#2500)
