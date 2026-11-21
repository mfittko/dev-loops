# 0302. Judge skip on zero-finding gate rounds

## Status

Accepted

## Context

A `draft_gate` or `pre_approval_gate` round with zero consolidated findings still dispatched a judge pass. Per-finding disposition has no input on such a round, and the scope-drift verdict derives from the recorded spec identity. The PR 2923 cycle spent about 5.35M tokens on three empty judge passes. The standalone `review` gate already skips the judge on a zero-findings ledger (`REVIEW-GATE-JUDGE-PHASE`). Coordinators applied a prose-only skip inconsistently.

## Decision

`emitJudgeWorkOrder` decides the skip. After source validation, it returns `judgeSkipped: { reason: "no_findings", specDigest }`, a `within_scope` `scopeDrift` derived from the spec identity, and a `nextStep` when the findings read is a well-formed ledger with zero entries and no `copilot-body-feedback` read is pinned (`GATE-EXEC-COPILOT-BODY-TO-JUDGE`). It writes no work order, execution-index entry or `judge-emit-plan.json`. The skip applies on every gate and execution mode. On a skip the gate coordinator runs no `judge-pass` and writes the findings log without `--judge-verdict` and `--ledger-out`. `renderGateReviewCommentBody` renders `**Judge:** skipped, the round has no findings to dispose` for any post whose findings ledger holds zero findings.

## Consequences

- Empty rounds spend no judge tokens.
- Rounds with findings, and rounds with a pinned Copilot body cluster, keep the judge.
- No `judge-pass --judge-skip` mode, no judge approvals record for a skipped round, and no `judgeSkipped` field in the durable ledger.
- The next round with findings starts a fresh approval chain.
