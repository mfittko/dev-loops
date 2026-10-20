### Fixed

- ui-review: lockfile-aware frozen install, boot log with early-exit stop, axe resolved from the reviewed worktree with a stated skip, per-state screenshots in the report (#2855)
- ui-review: the deck-fit Playwright harness skips per-slide axe for every deck suite (whole-deck axe runs once; per-slide axe exceeds the test timeout now that axe resolves), and the drive logs one stated line when axe is skipped (#2855)
