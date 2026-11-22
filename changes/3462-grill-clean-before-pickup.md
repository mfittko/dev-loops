### Changed

- An issue pickup in `loop startup` stops and prints the grill command unless the issue has a clean grill with a `## Simplest design` section and a `simplicity-review:` line (#3462)
- An issue grilled before this change needs one more grill, because it has no review line; work with an open PR keeps its route (#3462)
- The grill runs one fresh `review` agent with the `kiss` and `yagni` prompts, the new default of `refinement.roles` (#3462)
