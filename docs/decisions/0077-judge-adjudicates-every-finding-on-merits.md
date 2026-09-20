# 0077. First-round gate adjudicates every finding on merits: no severity-based auto-defer, plus internal severity calibration

## Status

Accepted — 2026-09-20 ([PR 2308](https://github.com/mfittko/dev-loops/pull/2308))

Amends [ADR 0051](./0051-net-reduction-disposition-policy.md): that record set the judge's high `defer` bar (a `low` defers only when operator-visible, else `reject`) to stop the loop net-adding backlog. It left the disposition surface reading as if a `low` were only ever `defer` or `reject` — never `act` — so a real defect labeled `low` was ruled out of an up-front fix on its severity label alone. This record keeps 0051's filing bar intact (a cosmetic `low` still `reject`s, a `low`/`nit` still files nothing) and adds the missing `act` path plus an internal-reviewer severity-calibration rule.

## Context

Observed on PR #2302 during the v1.0.4 drain: findings the internal draft-gate reviewers labeled `low` were later re-surfaced by Copilot as HIGH/MID — real defects a severity-based auto-defer let through, costing a Copilot round to re-raise. Two coupled defects. First, disposition: the judge guidance treated severity as an auto-gate — a `low` was defer-or-reject only — pre-empting the per-finding relevance judgment that decides whether a finding is a real defect worth fixing up front. Second, calibration: the internal fan-out reviewers under-labeled some real correctness/fail-open findings as `low` that an external reviewer rates HIGH/MID, so the internal gate leaned on Copilot to re-surface them at the correct severity (the same "internal gate must be independently sufficient" theme as #1961). The judge/fixer pipeline is already severity-blind on the act path (judge-pass's act filter reaches the fixer for any `act`, regardless of severity), so the auto-defer lived entirely in the guidance prose, not in code.

## Decision

Severity is an INPUT to the judge, never an auto-gate. The judge adjudicates EVERY finding — including a `low` — on its merits: reality plus relevance to the acceptance criteria / definition of done. A genuine defect relevant to the AC/DoD (a correctness bug, a fail-open/fail-closed gap, a security regression, or an AC-breaking defect) is `act` regardless of its severity label, including a `low`; round 1 is the cheapest fix point, so a real AC-relevant `low` is acted up front rather than deferred into a later Copilot round. 0051's net-reduction filing bar is preserved unchanged: a `low` that is real but out of this PR's scope is `defer` only when leaving it unfixed would change an operator-visible outcome, a genuinely non-blocking/cosmetic `low` defaults to `reject`, and a `low`/`nit` still files no follow-up issue on its own. Acting a real `low` in-PR files nothing, so it is strictly more net-reduction-friendly than deferring it.

Calibration: the internal reviewer severity rubric is tightened so a real correctness/fail-open defect is not labeled `low`. A defect that breaks correctness on a reachable path, or opens a fail-open / security / fail-closed gap, is at least `medium` — never `low` — no matter how small the diff; `low` is reserved for a real defect with no operator-visible consequence. This lives in the reviewer-facing severity classification (the [Gate Review Sub-Loop Contract](../../skills/docs/gate-review-sub-loop-contract.md) consolidation section and `agents/review.agent.md`) so every fan-out reviewer applies it.

We rejected forcing every `low` to be fixed (a genuinely cosmetic `low` still `reject`s) and rejected changing which severities BLOCK a clean verdict (`blockCleanOnFindingSeverities` is untouched). We rejected a mechanical enforcement of the merit disposition: the judge and reviewers are LLM roles, so the durable fix is the contract prose the roles are briefed with, guarded by conformance tests.

## Consequences

Real defects are fixed at the cheapest point (round 1, in-PR) instead of escaping the internal gate as under-labeled lows and costing a Copilot round to re-raise. Backlog growth does not increase: acting a real `low` files nothing, and the cosmetic-low reject bar from 0051 is unchanged. The internal gate rates severity comparably to an external reviewer for the recurring correctness/fail-open classes, so it is independently sufficient rather than Copilot-dependent. The trade-off is that the judge must exercise more per-finding judgment on lows rather than applying a severity shortcut — accepted, because the shortcut was letting real defects through.
