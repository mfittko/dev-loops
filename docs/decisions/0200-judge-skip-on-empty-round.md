# 0200. Skip the judge on an empty gate round

## Status

Accepted — 2026-10-28 ([issue 2926](https://github.com/mfittko/dev-loops/issues/2926))

## Context

A gate round can finish with zero consolidated findings. The judge then has nothing to decide, and the call costs time and tokens. Issue 2926 asks for a deterministic skip.

## Decision

- A round with zero consolidated findings, no carried act item and a non-blocked verdict skips the judge through `judge-pass --judge-skip`. The rule is `GATE-EXEC-JUDGE-SKIP-EMPTY`.
- Scope drift is derived from the recorded spec identity.
- Any other round still runs the judge.

## Consequences

The skip notice reaches the PR comment through `findingsSummary`. A rendered, ledger-driven skip line is a follow-up after PR 2898.
