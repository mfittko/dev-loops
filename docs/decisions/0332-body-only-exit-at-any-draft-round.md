# 0332. A draft_gate round whose act items are all PR-body items clears with a body-only converged post at any round

## Status

Accepted, 2026-11-26 ([issue 3611](https://github.com/mfittko/dev-loops/issues/3611); evidence: the issue 3599 pull request hit this state at round 2 of cap 4, and the targeted tests in `packages/core/test/converged-draft-gate.test.mjs`, `test/loop/detect-pr-gate-coordination-state.test.mjs` and `test/github/upsert-checkpoint-verdict-converged.test.mjs` pass).

Amends decisions 2 and 4 of [ADR 0271](./0271-body-only-cap-round-exit.md): the scope "cap round" of decision 2 and the routing of decision 4. The base-merge carry of [ADR 0294](./0294-converged-draft-gate-record-carries-from-its-fixer-commit.md), which also amends ADR 0271, stays in force. ADR 0271 stays unedited.

## Context

A `draft_gate` round below the cap whose open act items are all PR-body items had no exit without an operator step. The lane fixed the items with a PR-body edit, so the head did not change. Gate coordination returned `run_draft_gate`. A same-head round refused `GATE-EXEC-ROUND-RETIREMENT`, because a verdict was already recorded. The body-only converged post refused "applies only at the cap round or later". The only exits were an operator-confirmed round retirement or an artificial code commit (`GATE-EXEC-NO-DEAD-END`, parent `PURPOSE-STEER-NOT-TRAP`).

## Decision

1. `composeBodyOnlyConvergedDraftGate` has no cap-round condition. The body-only converged post applies at every `draft_gate` round up to the cap and at cap 0. Every other narrow check of ADR 0271 decision 2 stays: `body_item_locatable`, `body_unchanged`, `body_read_unrecorded`, `own_commit_in_range`, `blocked_item` and the refusal of a `bodyOnly` input that carries a `deltaResult`. The low/nit delta convergence (`composeConvergedDraftGate`) keeps its cap condition.
2. `resolveDraftOpenActList` returns the `bodyOnly: true` act list for an all-PR-body open act list at every round up to the cap, and past the cap it returns `null`.
3. The refusal `delta_body_only_act_set` names only the body-only converged post as its recovery. The clause "run the next gate round below the cap" is deleted.
4. Below the cap, gate coordination routes a same-head all-PR-body `findings_present` round to the body-only post and never to `run_draft_gate`. It returns `report_blocked` with the runnable `agentRemedy` of ADR 0271 (the PR-body edit and the post), or `blockedOn: operator_decision` when the act list carries a blocker. At the cap the route is unchanged from ADR 0271. A base-only merge of the reviewed head carries the body-only route at every round up to the cap (ADR 0294): coordination at the merged head names the carried post and forbids `run_draft_gate`. Coordination reads no PR-body digest: an unedited body makes the poster refuse `body_unchanged` with "edit the PR body first", which is a runnable exit.

## Consequences

A PR-body round below the cap clears with no commit, no operator step and no extra full round. The `pre_approval_gate` body-only exit (issue 3604) and the automatic retirement of a round with no posted verdict (issue 3612) stay out of scope. The round cap and the fix budget are unchanged.
