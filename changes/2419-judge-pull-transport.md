### Changed

- The judge receives only a compact `dispatchPrompt` and pulls its work order with `pull-work-order.mjs` (#2419)
- The new `emit-judge-work-order.mjs` derives the judge work order from the ledger, spec, identity, evidence and prior verdicts (#2419)
- `pull-work-order.mjs` registers the `judge` role and refuses a superseded, retired or source-changed judge reference as `stale_dispatch` (#2419)
- `judge-pass.mjs` requires `--judge-plan` and fails closed without a matching judge pull receipt, with a verdict written before the pull, or with a ledger or spec the work order did not pin (#2419)
- The judge agent gains Bash for the pull only; the Claude Bash gate denies every other judge command (#2419)
