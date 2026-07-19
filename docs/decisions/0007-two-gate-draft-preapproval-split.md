# 0007. Require two separate, non-substitutable local gates: draft and pre-approval

## Status

Accepted

## Context

The PR lifecycle needed deterministic quality boundaries between local implementation, Copilot review, and human approval, with auditable evidence rather than trust in the agent's self-report. [PR 170](https://github.com/mfittko/dev-loops/pull/170) made both gate verdicts visible as PR comments, [issue 318](https://github.com/mfittko/dev-loops/issues/318) defined the reusable review chain each gate executes, and [issue 357](https://github.com/mfittko/dev-loops/issues/357) moved the draft-first requirement out of AGENTS.md prose into config. The canonical texts are the [PR lifecycle contract](../../skills/docs/pr-lifecycle-contract.md), the [checkpoint verdict comment contract](../../skills/docs/gate-review-comment-contract.md), and the [checkpoint review chain contract](../../skills/docs/gate-review-sub-loop-contract.md).

## Decision

Every PR crosses two independent local gates: `draft_gate` before the draft→ready transition and `pre_approval_gate` before final approval. Each gate runs its own complete review chain — its own angles, disposition ledger, fix cycle, and exit conditions (`GATE-EXEC-SEPARATE-CHAINS`) — and a clean pass of one gate never satisfies the other (`GATE-EXEC-NON-SUBSTITUTION`). Every gate-crossing verdict binds to the current head SHA: the draft gate is a one-time transition boundary satisfied at the head that leaves draft, while the pre-approval gate recurs for each new head. `workflow.requireDraftFirst` makes the draft boundary mandatory, and dispatch carve-outs change only how a gate runs, never whether the boundary exists. We rejected letting one gate's clean pass substitute for the other, and we rejected prose-only enforcement of the draft boundary, which lacked a machine-checkable knob.

## Consequences

Lifecycle routing, evidence detection, merge preconditions, and CI checks all assume the two-gate split and per-head verdicts. Auditability comes from durable per-gate disposition ledgers and visible checkpoint comments on the PR, not from session-local artifacts or agent self-report. Every PR pays for two full review chains — exactly the cost that later carve-outs (light-mode inline dispatch, angle carry-forward) were designed to bound without removing either boundary.
