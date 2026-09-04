# 0055. Merit rationale for gate dispositions

## Status

Accepted — 2026-09-03 ([issue 1882](https://github.com/mfittko/dev-loops/issues/1882))

## Context

Gate findings may be deferred under the net-reduction policy. Severity and round eligibility select which disposition boundary applies, but they do not establish that a finding merits closure. Without a per-finding rationale, a technically permitted disposition can still be recorded as a severity-only shortcut.

## Decision

Resolve-without-fix replies for low, medium, and nit findings MUST include an explicit `Examined on merits:` rationale naming the finding and the applicable scope, acceptance-criteria, fix-window, or filing-bar basis. The disposition helper extracts the posted finding summary and fails closed when it cannot produce that per-finding rationale. Net-reduction and churn-avoidance rules remain unchanged.

## Consequences

Gate disposition records explain why each finding was considered and closed. Malformed or unavailable finding detail blocks automated closure instead of producing an unverifiable generic note. Existing accepted decision records remain unchanged; this record owns the guardrail introduced for issue #1882.

## References

- `GATE-EXEC-THREAD-DISPOSITION` in `skills/docs/gate-review-sub-loop-contract.md`
- `scripts/github/close-gate-findings.mjs`
