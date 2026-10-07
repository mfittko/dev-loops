### Fixed
- The Bash gate hook now denies raw PR and issue body writes (`gh pr edit`, `gh issue edit`, `gh api` body writes) before its quick allow pre-check can short-circuit them; every wrapped (`bash -c`/`eval`/`xargs`) `gh pr edit`, and an xargs-fed `gh issue edit` without an explicit non-body flag, are also denied for every actor because their flags cannot be inspected (#2689)
