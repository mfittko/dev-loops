### Fixed

- `emit-fixer-work-order.mjs --completion-only` re-enters a full fixer plan with a missing or stale disposition handoff as a delivery-only `operation: complete` order, and the completion text lists numbered push, confirm-remote-head and `--construct` steps (#2787)
- The fixer-disposition detector carries a complete `fixer-disposition-<X>.json` checkpoint to a live head that strictly contains `X`, so a PR whose head moved after verification advances past `complete_fixer_disposition` without a gate verdict (#2787)
