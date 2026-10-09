### Changed
- The fixer emitter refuses `--phase full` without a clearing pre-push delta decision, and fixed replies are refused for threads the delta review left unresolved (#2575)
- The `--phase full` act-list work order carries the same `siteCoverage` skeleton as `commit_only`, and a stale invocation-3 `bounded_out` record clears it (#2575)
