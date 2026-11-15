# 0275. A judged findings log persists `findings_present` over a non-empty act list

## Status

Accepted — 2026-11-15 ([issue 3105](https://github.com/mfittko/dev-loops/issues/3105)).

Amends [0089](0089-judge-act-list-drives-review-verdict.md). ADR 0089 composed only the posted verdict. Accepted records remain unchanged.

## Context

ADR 0089 made a non-empty judge act list keep a gate round from `clean` in the posted verdict. The durable findings log written by `write-gate-findings-log` still carried the consolidator severity verdict. A judged log with open `act` findings could therefore record `clean`, and other writers that read the log inherited the false value. Writers also passed `--verdict clean` by hand to reconcile the two values. The rules are `GATE-COMMENT-VERDICT-VALUES` in `skills/docs/gate-review-comment-contract.md`. See [issue 3105](https://github.com/mfittko/dev-loops/issues/3105).

## Decision

After a judge pass, `write-gate-findings-log` persists `overallVerdict` and `verdict` as `findings_present` whenever the judge act list is non-empty. A `blocked` verdict stays unchanged. A judged log no longer carries the consolidator severity verdict over open findings, and no writer is asked for `--verdict clean`.

A non-review write without `--judge-verdict` refuses with `judge_verdict_required` when a `gate-judge/j<n>-<hex>/judge-verdict.json` exists for the gate and head. A judge execution emitted before the round's fan-out emit plan (both ids carry their emission time) belongs to an earlier same-head round and does not trigger the refusal.

## Consequences

- The durable log and the posted verdict agree on a non-empty act list.
- The composed-verdict rule of ADR 0089 still stands for the posted verdict.
- The fan-in severity rule is unchanged. `blockCleanOnFindingSeverities` is a review-verdict input, not a log input.
- Rejected: change the fan-in severity rule. It would alter a review-verdict input and leave the log writer unaware of the judge.
- Rejected: fix the poster only. The false value lives in the durable log that other writers read.
