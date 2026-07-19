# 0040. Keep the autonomous queue driver dormant; make Next Up board pickup the live path

## Status

Accepted

## Context

[Issue 556](https://github.com/mfittko/dev-loops/issues/556) specified a full autonomous queue driver (`docs/specs/queue-mode/SPEC.md`): sequential lifecycle execution over an ordered queue, operator-pre-authorized autonomous merge, self-healing on recoverable failures, opt-in parallelism, and durable state in `.pi/dev-loop-queue.json`. The queue-state and driver infrastructure was built (`packages/core/src/loop/queue-driver.mjs`, `scripts/loop/run-queue.mjs`), but the live system evolved toward board-driven pickup with human merge authority, codified in `skills/docs/projects-queue-contract.md`. An earlier data-integrity incident ([issue 913](https://github.com/mfittko/dev-loops/issues/913)) showed the danger of the half-wired path: with no orchestrator supplying real terminal signals, the driver fabricated per-entry success and silently moved untouched Next Up items to Done. [PR 1425](https://github.com/mfittko/dev-loops/pull/1425) (commit `c950bd31`) amended the SPEC status to "Partially implemented", recording the shipped posture explicitly.

## Decision

We leave the autonomous queue driver deliberately unwired: `runQueue` guards on a missing `runEntry` orchestrator and returns a no-op result (`reason: "no-orchestrator"`) that touches no entry and no board column. The GitHub Projects V2 `Next Up` column, resolved via `scripts/projects/resolve-active-board-item.mjs`, is the live, fail-closed pickup source for autonomous work — empty Next Up idles with an explicit reason, board-query errors surface and stop, and Backlog is never auto-pulled. We amended the SPEC's status line so the partial implementation reads as intentional posture, not unfinished work. We rejected wiring the driver up (autonomous merge conflicts with the established human-only merge authority) and rejected the pre-guard fallback of fabricating per-entry success, which had silently drained Next Up to Done without doing anything.

## Consequences

Contributors reading the SPEC see the amended status and will neither wire up the dormant driver nor misread the no-op adapter as a bug. The system's autonomy model stays board-driven: agents pick work only from Next Up, and merging remains a human decision. The dormant driver code and its tests carry maintenance weight without a live caller, accepted as the cost of keeping the seam available. Actually wiring an autonomous orchestrator into `runQueue` is a policy reversal and requires a new record superseding this one.
