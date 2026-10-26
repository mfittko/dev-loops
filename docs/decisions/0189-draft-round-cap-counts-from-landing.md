# 0189. The draft round cap counts only rounds logged at or after the cap landing

## Status

Accepted — 2026-10-26 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462))

Amends [ADR 0185](./0185-draft-gate-round-cap-and-post-convergence-no-code-commit.md) for its Count bullet only. All other ADR 0185 decisions are unchanged. The record of ADR 0185 stays unedited.

## Context

On PR 2922, the `draft_gate` round 5 composed `blocked` with a `round_cap_reached` blocker. Four of the five counted rounds ran before the cap merged in PR 2932 (merged 2026-10-26T08:51:13Z). Those rounds ran under rules that had no cap. Operator decision of 2026-10-26: count from the cap landing.

## Decision

- Constant. `DRAFT_ROUND_CAP_EFFECTIVE_AT` is `2026-10-26T08:51:13Z`, the merge time of PR 2932.
- Count. A closed prior ledger counts toward the cap only when its `loggedAt` is at or after `DRAFT_ROUND_CAP_EFFECTIVE_AT`. A closed prior ledger whose `loggedAt` is missing or unparseable counts. An unreadable in-range ledger counts regardless of date. The round being posted counts.
- Source. `loggedAt` is a property of the round record, written by the findings-log writer. No commit author date is read.

## Consequences

Pull requests in flight at the landing get a fresh round budget. Rounds logged before the landing never count. Every other part of the cap, including past-cap composition and `capClosed`, is unchanged.
