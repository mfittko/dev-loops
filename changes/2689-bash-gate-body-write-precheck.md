### Fixed
- The Bash gate hook denies raw PR and issue body writes before its quick allow pre-check, and denies wrapped `gh pr edit` and xargs-fed `gh issue edit` whose flags it cannot inspect (#2689)
