### Added

- `pr create` refuses with `pre_pr_review_missing` unless `loop pre-pr-review` recorded a review for the branch head; `--lightweight` and plan-doc promotion branches (only `docs/phases/**/*.md` changed) are exempt (#2618)
