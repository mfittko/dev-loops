### Changed
- The operator `approve merge` marker may pin the PR patch-id (`approve merge <sha> patch-id <id>`), so a base-only head change keeps the approval (the id covers the added and removed lines and three context lines, from a pinned `git diff -U3` over bytes); `merge-pr` reports `approvalMatch` (#3048)
