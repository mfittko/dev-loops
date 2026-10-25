# 0185. A draft_gate round cap backs the delta rounds, and a converged head takes no code commit

## Status

Accepted — 2026-10-25 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462))

Amends [ADR 0168](./0168-draft-gate-low-nit-convergence.md): after a `draft_gate` round converges under 0168, tooling will refuse a code commit on that head. Enforcement ships in a later slice of issue 2462. Until then `GATE-EXEC-LOW-NIT-CONVERGENCE` is unchanged and still prescribes the one `commit_only` fixer pass for an all-low/nit act list. The records that introduced 0168 stay unedited.

## Context

Across 49 pull requests with two or more draft rounds, 99 new act findings first appeared at round 4 or later. Most were low or nit. A round whose act items are all low or nit never converged, because each fixer pass added code that the next full round reviewed again. Operator decisions of 2026-10-25 (PR 2848 and PR 2916 retros) set the rule for the head after convergence.

## Decision

- Role. `gates.draft.maxReviewRounds` (default 4, `0` disables) is the backstop for rounds that still do not converge after delta rounds. Delta rounds stay the primary convergence mechanism.
- Count. One completed round is one durable `draft_gate` ledger of the pull request with verdict `clean` or `findings_present`, read with `readClosedPriorRoundLogs`. The round being posted counts. An unreadable in-range ledger counts. A round is past the cap when the count is at or above the cap. The posted `round=` marker uses the same count.
- One input. When the cap is on, the cap evaluates only the judged ledger of the round. `upsert-checkpoint-verdict.mjs` refuses every other `draft_gate` input shape at one choke point before the cap logic runs.
- Past the cap, a new act item composes `blocked` with a `round_cap_reached` blocker and no fixer runs. A round whose act items are all low or nit converges through the 0168 rule. A mixed round blocks.
- `capClosed`. Past the cap, a judge `defer` or `reject` is closed with `capClosed: { judgeDisposition, severity, round, cap }` in the ledger. A reviewer `high` or `medium` that the judge defers or rejects, a missing disposition and an unknown severity join the blocker with reason `severity_disagreement`. A locatable `question` is never cap-closed.
- `resurfaces`. The judge receives prior act items as `{fingerprint, file, line, title}`. The ledger writer keeps `resurfaces` only for a fingerprint in that list when the finding's file equals that prior item's file. A re-surfaced `high` or `medium` act item past the cap blocks with reason `resurfaced`.
- Post-convergence push (operator decision, 2026-10-25). After a `draft_gate` round converges under 0168, tooling refuses a code commit on that head with a typed reason. Review threads on a converged head resolve by reply only. Low and nit items close by reply or PR-body edit only. This overrides the one `commit_only` fixer pass of 0168. The enforcement of this rule ships in a later slice of issue 2462; this ADR records the decision.

## Consequences

A capped pull request stops at the cap round without an operator override. The count is the same for every angle and dispatch shape. Visibility of `capClosed` items in the verdict comment and merge-ready result, and the post-convergence refusal, arrive in later slices.
