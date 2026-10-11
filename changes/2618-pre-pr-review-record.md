### Added

- `pr create` refuses with `pre_pr_review_missing` unless `loop pre-pr-review` recorded a review for the branch head (or an ancestor head with only docs and test changes since); a `--lightweight` create and a `docs/phases/**/*.md` promotion branch are exempt (#2618)
