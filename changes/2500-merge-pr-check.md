### Added
- `merge-pr.mjs --check` reports the merge class, the exact `approve merge <headSha>` line and every failing precondition without merging (#2500)
- A merged PR gets a record comment naming the approval path, approver and head SHA, and a later PENDING draft no longer hides an APPROVED review (#2500)
- `merge-pr.mjs --check` reads size facts from the current-head marker, keeps the escalated class on a size-gate failure, reports no class without facts, and writes no heartbeat (#2500)
