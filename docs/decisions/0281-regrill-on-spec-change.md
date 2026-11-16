# 0281. A spec change after the latest grill sends the issue back to the grill

## Status

Accepted, 2026-11-16 ([issue 3127](https://github.com/mfittko/dev-loops/issues/3127)).

## Context

A grill pass posts a `🔬 Grill / refinement results` comment and folds its findings into the issue body and its AC / DoD matrix. Comments are not part of the requirements. An operator or a reviewer can still add a comment or edit the body after the grill. Before this decision, a recorded results comment marked the issue as refined, and `loop startup` and the pickup gate accepted it. The newer content then reached implementation without a grill pass, and the body no longer matched what the operator asked for.

## Decision

`GRILL-SUBLOOP-SPEC-CHANGED-SINCE-GRILL` in [the refinement grill state graph](../refinement-grill-state-graph.md) owns the rule. `detectSpecChangedSinceGrill` in `packages/core/src/loop/refinement-grill-state.mjs` compares the `createdAt` of the latest results comment with each counted comment and with the body's GraphQL `lastEditedAt`. A later counted comment or a later body edit resolves a zero-gap pass to `detect_gaps` with reason `spec_changed_since_grill`. A grill pass writes its body edit first and posts its results comment second, so the edit dates before the comment and does not count as a change.

Loop-owned comments do not count. A comment counts unless its first non-empty line opens with `<!-- dev-loops:`, it is a merge record, it is a results comment, or its first non-empty line is an operator-owned line (`OPERATOR-OWNED-LINE`). An operator-owned line on any later line does not exempt the comment.

The check fails closed. A results comment with no parseable `createdAt`, when no results comment is dated, resolves to `spec_changed_since_grill`. A comment window that drops older comments and holds no results comment resolves the same way.

`loop startup` runs the check when `issueReadiness` is `ready`. On a spec change it reports `issueReadiness` `needs_clarification` with `issueReadinessReason` `spec_changed_since_grill`. It stops with a `needs_reconcile` bundle and a re-grill `nextAction` on every target preference. When the spec-change read fails, startup stops the same way with reason `spec_change_read_failed` and a retry-startup `nextAction`. [The public dev-loop contract](../../skills/docs/public-dev-loop-contract.md) names both reasons and the routing.

`QUEUE-ENQUEUE-REFINEMENT-GATE` in [the projects queue contract](../../skills/docs/projects-queue-contract.md) treats `spec_changed_since_grill` like a missing refinement artifact. `queue add` and a `queue move` to the pickup column block with exit code 4. Under `--auto` they divert the issue to the non-pickup park column. `queue parked-unrefined` lists the diverted issue with finding `spec_changed_since_grill`, so the headless auto-refine pass re-grills it.

## Consequences

- The re-grill reads the counted comments and the body edits after the latest results comment. It folds the accepted content into the body and its AC / DoD matrix, then posts a new results comment. That comment clears the reason.
- A bypass line on an earlier results comment does not exempt the issue from the check.
- Every counted comment forces a re-grill, including a milestone-move note or a comment with no requirement content. The grill pass decides whether the comment changes the spec.
- Open item, deferred (tracked in #3227): the grill misses comments made while a grill pass runs. A comment posted after the grill reads the comments and before it posts its results comment is older than the new results comment. The check does not see that comment, and the issue passes as refined.
