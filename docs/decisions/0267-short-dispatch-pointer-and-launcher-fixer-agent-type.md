# 0267. The short pull pointer replaces the 3-flag form, and a launcher override names the bare fixer

## Status

Accepted — 2026-11-12 ([issue 2560](https://github.com/mfittko/dev-loops/issues/2560))

Amends [0107](./0107-fixer-mutation-authority-bound-to-pulled-work-order.md) for the launcher override: when `DEVLOOPS_AGENT_OVERRIDES` lists `fixer`, the dispatched fixer type is the bare `fixer`. Every other decision of that record stays in force, and the record stays unedited.

Amends [0179](./0179-judge-in-standalone-review.md) for the judge exemption: the standalone review gate judge is now recognized through the execution index, because the short pointer carries no ref.

Implements step 2 of [0115](./0115-dispatch-pointer-carries-the-execution-identity-alone.md), which [0164](./0164-coordinator-execution-identity-prefix.md) already amends.

Builds on the records that already amend the ones touched here:

- ADR 0213 and ADR 0233 amend 0107.
- ADR 0183 amends 0179.
- ADR 0179 amends ADR 0116.

## Context

Step 1 of 0115 (issue 2551) made the pull, the hooks and the fixer binding accept both pointer forms. The emitters kept the 3-flag form. Copying the digest into that form keeps failing, and the 3-flag form carries the ref that `isStandaloneReviewJudgePointer` read. ADR 0107 says the Claude payload names `fixer` in a dev-loops source checkout and `dev-loops:fixer` elsewhere. Since issue 2602, `claudeFixerAgentType` returns the bare `fixer` whenever the override lists `fixer`, and `decideAgentDispatch` denies `dev-loops:fixer` then.

## Decision

- Every emitter writes `dev-loops-run scripts/github/pull-work-order.mjs <executionIdentity>`. The pull, `decideAgentDispatch`, the fixer pull-line binding and the Pi read-only gate accept only that form. The pull refuses the 3-flag form with exit 2.
- The agent guard hook resolves a judge pointer's identity to its `workOrderRef` through the execution index of every checkout and passes it to `decideAgentDispatch` as `judgeWorkOrderRef`. Only a judge pointer whose ref names gate `review` is exempt from `GATE_COORDINATOR_REQUIRED`. An identity with no index entry is denied, so ADR 0116 stays in force for lifecycle-gate judges.
- When `DEVLOOPS_AGENT_OVERRIDES` lists `fixer`, the emitted Claude payload names the bare `fixer` and the agent guard denies `dev-loops:fixer` (`AGENT_OVERRIDE_NAMESPACED_DISPATCH`). Without that override, ADR 0107 holds: `fixer` in a dev-loops source checkout and `dev-loops:fixer` elsewhere. The hooks keep normalizing both names through `normalizeAgentType`.
- A fixer dispatch is exactly the `dispatchPayload` that `emit-fixer-work-order.mjs` prints. The coordinator never sends a prose fixer brief.

## Consequences

- Rounds emitted before the upgrade carry the 3-flag pointer, which the pull now refuses. Re-emit them after the upgrade.
- A judge pointer whose index entry sits in no checkout of the repository is denied from the dev-loop agent.
- The emitter needs no behavior change for the override; only its docstring changes.
