# 0316. CI smoke-job timeouts route to a bounded re-run

## Status

Accepted

## Context

A smoke job can time out on a slow runner while the code under test is correct ([issue 3251](https://github.com/mfittko/dev-loops/issues/3251)). The fixer work order treated every failed CI check as a code defect and dispatched a fixer. The fixer could not change the outcome, and each dispatch cost a full fix pass.

## Decision

When the only failed check on a head is a smoke-job timeout, the fixer work order routes to the sanctioned re-run script `scripts/github/rerun-failed-ci.mjs` instead of a fixer. The script re-runs the failed jobs of the run for that head. It allows a bounded number of attempts per head and refuses further attempts. After the bound, the failure routes to a fixer as any other CI failure.

Any other failed check, or a smoke failure that is not a timeout, keeps the existing fixer route. `skills/docs/gate-review-sub-loop-contract.md` names the re-run route.

## Consequences

- A runner-speed timeout costs one re-run and no fixer dispatch.
- The per-head attempt bound stops an endless re-run loop on a real hang.
- The re-run script joins the sanctioned command list, so the Bash hook accepts it.
