### Added

- `pr create` refuses with `pre_pr_review_missing` unless `dev-loops loop pre-pr-review` recorded a pre-PR review for the branch head (#2618); the refusal stderr envelope carries `code: "pre_pr_review_missing"`, `origin/<head>` divergence is refused, and only a `docs/**/*.md` plan-doc promotion branch is exempt (#2618)
