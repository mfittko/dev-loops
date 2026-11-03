### Added

- `emit-fixer-work-order --completion-only` re-enters an incomplete full plan for delivery only, and `--phase commit_only` refuses while that plan is active at its candidate with no new commit (#2787)
- `emit-fixer-work-order` pins its own copy of the act list in the plan directory, so a later `judge-pass --out` overwrite no longer breaks the fixer byte checks (#2787)
- `operation: complete` admission requires a `completesExecution` root and pull refuses `stale_dispatch` once the root execution sequence is closed (#2787)
