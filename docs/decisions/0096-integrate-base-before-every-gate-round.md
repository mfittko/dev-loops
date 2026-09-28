# 0096. Integrate the base branch before every gate round

## Status

Accepted — 2026-09-25 ([issue 2438](https://github.com/mfittko/dev-loops/issues/2438))

Amends [ADR 0066](./0066-pr-pickup-integrate-base-first-never-ci-wait-dirty.md): that record integrates the base branch at PR pickup. This record extends the same integration to the entry of every gate round and reuses its integration tool. The pickup preflight stays as ADR 0066 decided.

## Context

A gate round runs the gate tooling that the PR head contains. During the v1.0.4 drain, a branch cut before a gate-tooling merge ran the old tooling. PR 2417's `pre_approval_gate` round 1 at `e6a3611a` composed `clean` over four judge `act` items, because that head did not contain `93b53e2e` (PR 2411, ADR 0089). Every runner brief then repeated an interim rule: merge `origin/main` before each gate round. AGENTS.md requires durable rules to live in contracts or tooling, never in prompts alone. The operator accepted the amendment on 2026-09-25 (mfittko).

## Decision

- New rule `GATE-EXEC-BASE-REFRESH` in `skills/docs/gate-review-sub-loop-contract.md`. Before the dev-loop coordinator dispatches a `draft_gate` or `pre_approval_gate` round, it fetches the base branch. When `origin/<base>` is not an ancestor of the PR head, it integrates the current base into the PR branch.
- The coordinator integrates through `scripts/loop/resolve-pr-conflicts.mjs`, the tool ADR 0066 uses at pickup. The tool runs `git merge --no-edit origin/<base>`, so the merge commit carries git's default merge subject. It auto-resolves only additive CHANGELOG conflicts and otherwise fails closed. On a fail-closed result the coordinator stops and reports.
- The coordinator pushes the merge before it dispatches the round. On a ready PR, the `pre_approval_gate` re-runs on the new head per `GATE-EXEC-REGATE-MANDATORY`.
- An integrate-only base move keeps carry-forward eligibility through the base-relative delta that `GATE-EXEC-ANGLE-CARRY-FORWARD` already defines.

Rejected: leaving the refresh as a runner-brief rule (it drifts between sessions and harnesses); a new integration tool (the sanctioned resolver already covers the merge and its fail-closed conflict handling); rebasing the PR branch (it rewrites the reviewed history and needs a force push).

## Consequences

Every gate round reviews a head that contains the current base, so it runs the current gate tooling. A PR behind its base gets one merge commit and one extra head per round entry, and a ready PR re-gates that head. Carry-forward limits the re-gate cost for an integrate-only move. A base conflict outside CHANGELOG stops the loop before the round and needs a manual resolution. The behavior of `resolve-pr-conflicts.mjs` does not change.
