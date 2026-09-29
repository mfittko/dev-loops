# 0116. The dev-loop coordinator keeps its pre-PR and delta review dispatches

## Status

Accepted — 2026-09-29 ([issue 2558](https://github.com/mfittko/dev-loops/issues/2558))

Amends [ADR 0112](./0112-gate-coordinator-agent-joins-the-agent-taxonomy.md): that record denies every `review` dispatch from a `dev-loop` caller. This record narrows the deny to a `review` dispatch whose prompt carries a work-order pull. The rest of ADR 0112 stands.

## Context

`decideAgentDispatch` denied every `review` and `judge` dispatch from the `dev-loop` agent with `GATE_COORDINATOR_REQUIRED`. The contracts still give the dev-loop coordinator two `review` dispatches that are not gate-round units: the pre-PR full review and the delta reviewer of `PRE-PUSH-DELTA-TRIGGER` (both in `skills/docs/pre-pr-review-contract.md`). After ADR 0112 took effect, no dev-loop run could push an act-list fix, because the delta review must run before the push and the hook denied its dispatch.

## Decision

- A `dev-loop` caller that dispatches `review` is denied with `GATE_COORDINATOR_REQUIRED` only when the prompt carries a work-order ref token (`review:`, `judge:` or `fixer:` followed by `owner/repo#N:`) or an execution identity token, in any flag order, quoting or wrapping. A prose-briefed `review` dispatch from `dev-loop` is allowed.
- A `dev-loop` caller that dispatches `judge` is denied with `GATE_COORDINATOR_REQUIRED` for every prompt.
- The `gate-coordinator` rules of ADR 0112 are unchanged.

A gate-round unit is reached only through a work-order pull. A `review` prompt that carries neither the unit's work-order ref nor its execution identity cannot pull it, so it cannot produce a gate-round result, because fan-in accepts only pull-bound unit artifacts.

Rejected: an allow-list of pre-PR and delta prompt shapes (the contracts brief these reviewers in prose, so no stable shape exists to match).

## Consequences

The dev-loop coordinator runs its pre-PR and delta reviews again, and act-list fixes can be pushed. A dev-loop coordinator that sends a `review` prompt that carries a work-order pull, or dispatches any `judge`, is still routed to the gate coordinator. A dev-loop coordinator can still run a gate-round-like review in prose; fan-in rejects its output as a gate-round result.
