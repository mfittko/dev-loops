### Fixed

- `loop pre-push-delta --reviewer-only` reviews the overlap paths of a clean base merge with an empty remerge diff, so a `locally_clear` result clears the cap-round chain, including when the PR renamed a file that main edited, where the rename destination joins the overlap (#3356)
