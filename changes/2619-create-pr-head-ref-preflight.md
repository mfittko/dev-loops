### Fixed
- pr create runs the comment-discipline preflight on the --head ref and refuses an unresolvable head with head_unresolvable on --lightweight (the default path refuses it earlier with pre_pr_review_missing, which also names git fetch origin) (#2619)
