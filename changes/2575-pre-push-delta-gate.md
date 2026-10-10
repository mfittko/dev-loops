### Changed
- The fixer emitter refuses `--phase full` without a clearing pre-push delta decision, and fixed replies are refused for threads the delta review left unresolved (#2575)
- The `--phase full` act-list work order carries the same `siteCoverage` skeleton as `commit_only`, and a stale invocation-3 delta result clears it when its item ref/status pairs match the head's delta record (#2575)
- `check-pre-push-delta.mjs --threads-file` reviews a thread-driven fix, and each run writes a `gate-delta/<baseline>.json` decision record that the emitter and the reply paths read (#2575)
- `request-copilot-review.mjs` reports the status `blocked_by_fixer_disposition`, with the failedSteps `not_verified` and `delta_blocked`, when the fixer disposition boundary blocks a request (#2575)
