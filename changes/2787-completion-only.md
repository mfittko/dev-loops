### Fixed

- `emit-fixer-work-order.mjs --completion-only` re-enters a fixer plan with a missing or stale disposition handoff as a delivery-only `operation: complete` order (#2787)
- The completion text lists numbered push, confirm-remote-head and `--construct` steps, in that order (#2787)
- The fixer-disposition detector carries a complete `fixer-disposition-<X>.json` checkpoint to a live head that strictly contains `X` (#2787)
- A PR whose head moved after verification now advances past `complete_fixer_disposition` without a new fixer round; the next gate round still re-reviews the live head in full (#2787)
- The carry requires the checkpoint at X to record as tackled every thread the plan's handoff tackles, and a THREAD plan to record every pinned thread in both files (#2787)
- The contract documents `staleFixer` and `FIXER_RESULT_STALE` beside `activeFixer` (#2787)
- The carry re-checks every tackled thread live and never overrides an unverified live-head handoff (#2787)
- THREAD full-order verifier-step render bytes intentionally change (#2787)
