### Added

- `loop pre-pr-review --scan` runs the stale-surface sweep and PR body versus issue check; the record writer refuses unaddressed hits (#2807)

### Changed

- Record mode of `loop pre-pr-review` now requires `--body-file <file> --issue <n>` or `--no-linked-issue`, refuses an empty scan range, and refuses unaddressed stale-surface hits with `pre_pr_stale_surface_unaddressed`. The earlier `--verdict ... --disposition ...` form without these flags exits 1 and writes no record (#2807)
