# 0012. Enforce the post-run retrospective as a required checkpoint and pre-merge gate

## Status

Superseded by [0025](0025-retrospective-advisory-reversal.md)

## Context

Qualifying async dev-loop completions (Copilot PR follow-up and issue intake routes) were expected to end with a behavioral retrospective, but enforcement was prompt-only, so agents finished runs and moved on without durable evidence that the retrospective happened ([PR 172](https://github.com/mfittko/dev-loops/pull/172)). Even after startup gating existed, retrospectives were still skipped at the merge boundary: two PRs were merged without them, prompting a proposal to block unattended merges outright ([issue 492](https://github.com/mfittko/dev-loops/issues/492)). The shipped `extension-defaults.yaml` later turned both gates on for every consumer, contradicting the code default and the opt-in contract ([issue 841](https://github.com/mfittko/dev-loops/issues/841), fixed by [PR 845](https://github.com/mfittko/dev-loops/pull/845)). The core question was whether self-improvement output should be allowed to block delivery. The enforcement seam lives in `skills/docs/retrospective-checkpoint-contract.md` and `packages/core/src/loop/retrospective-checkpoint.mjs`.

## Decision

Make the retrospective a required checkpoint whose absence blocks the next qualifying start or resume, rejecting the status quo of prompt-only encouragement as unenforceable. A `.pi` extension writes a durable four-state checkpoint file (`none`, `required`/missing, `complete`, `skipped`-with-reason), and the pure function `evaluateRetrospectiveGate` fails routing closed to `needs_reconcile` when the checkpoint is missing or unrecognized; the extension trigger stays message-based rather than doing deep route inspection. Gate enforcement config-wise via `workflow.requireRetrospective` with permissive shipped defaults so this repo opts in and consumers stay unaffected. Then escalate the checkpoint to a merge gate: block unattended merges unless a completed retrospective explicitly approves the merge and records an internal-tooling audit of the loop's own raw `gh`/`python`/`node -e` calls, controlled by `workflow.requireRetrospectiveGate`.

## Consequences

Startup gating worked as designed, but the merge gate deadlocked loops and blocked ordinary product PRs on self-analysis and tooling-classification noise — self-improvement output was in the delivery critical path. The shipped defaults accidentally forced the gate on for every consumer until they were corrected back to off, the internal-tooling requirement was disabled pending rework, and the config wiring itself was reverted once before that. The gate was finally removed entirely: the retrospective is now advisory, its findings travel in the handoff envelope and an advisory PR comment, and it must never block a merge or PR-lifecycle transition (record 0025). The episode became the repo's canonical example of an over-enforced modality: a valuable practice made mandatory at the wrong boundary.
