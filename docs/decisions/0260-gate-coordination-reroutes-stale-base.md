# 0260. Gate coordination reroutes a stale base

## Status

Accepted — 2026-11-09 ([issue 2885](https://github.com/mfittko/dev-loops/issues/2885))

Extends [ADR 0194](0194-stale-base-preflight-on-lifecycle-gates.md). It does not supersede it.

## Context

Four coordinators dispatched a gate round on a stale base on 2026-11-08 and 2026-11-09. `loop gate-coordination` returned a gate-run action at such a head. ADR 0194 refuses a stale base only at `write-gate-context` dispatch, so the coordinators learned about the stale base after they had committed to a round. The operator chose option A on 2026-11-09: check at the existing seams. A push hook is not planned.

## Decision

- Rule `ADR0260-COORDINATION-STALE-BASE-REROUTE`. `loop gate-coordination` runs `checkBaseFreshness` only when the evaluator returned `run_draft_gate` or `run_pre_approval_gate`. `checkBaseFreshness` is the ADR 0194 predicate. It gives one `git merge-base --is-ancestor`-equivalent verdict, shared with the merge seam.
- A stale head returns `resolve_merge_conflicts` with reason `base_stale_integrate_first`, boundary `CONFLICT_RESOLUTION`, disposition `action_required`, and the evaluator's conflict forbidden list.
- A failed fetch or an unresolved head keeps the original action and records `baseFreshness`. `write-gate-context` still refuses in those cases (`ADR0194-STALE-BASE-PREFLIGHT`).
- No new action value is added.
- Rejected: a push hook that detects staleness. The existing seams already cover every gate round, so a hook adds a mechanism without new coverage.

## Consequences

The coordinator sees a stale base before it starts a round. Each gate-run result costs one extra fetch. A fetch failure still surfaces at `write-gate-context`, so the fail-closed guarantee of ADR 0194 is unchanged.
