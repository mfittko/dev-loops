### Fixed
- The Bash gate hook now denies raw PR and issue body writes (`gh pr edit`, `gh issue edit`, `gh api` body writes) before its quick allow pre-check can short-circuit them (#2689)
