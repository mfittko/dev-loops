# 0187. Claude Code coordinator report path: one hand-back, plain-text pauses, output-file read

## Status

Accepted — 2026-10-26 ([issue 2611](https://github.com/mfittko/dev-loops/issues/2611), slice 1).

Amends [0056](0056-bounded-parallel-gate-dispatch.md). The body of 0056 is unchanged. Its "No mid-chain turn-ending" and "Blocking join for a nested single-child step" bullets will hold for Pi only once the remaining slice of [issue 2611](https://github.com/mfittko/dev-loops/issues/2611) lands. Related: [0069](0069-claude-harness-fanout-concurrency-clamp.md), [0095](0095-single-wave-gate-fanout.md), [0112](0112-gate-coordinator-agent-joins-the-agent-taxonomy.md).

## Context

On Claude Code, a coordinator that called `SubagentHandback` while a child was still running burned the run's single delivery slot. A later report was refused as already delivered, and the parent held only the interim report. Retros of PR 2597, PR 2717, PR 2720, PR 2808 and PR 2810 recorded the same pattern. A crossed decision message also read as a stall, because a hand-back did not say which relayed message it consumed.

Issue 2579 already replaced the universal blocking join with a harness-scoped join. A gate coordinator joins its units with `dev-loops gate wait-for-units`. The dev-loop coordinator joins its gate coordinator, developer and fixer through their completion notification.

## Decision

On Claude Code the report path has three parts.

1. A dev-loop coordinator run makes one `SubagentHandback` call. It carries the final report: the hand-back at the first `unitBoundaries.handBackAfter` boundary, `final_approval_ready`, or a stop that needs a caller decision.
2. A pause is a turn end while the run is not finished. It ends the turn with plain text and never calls `SubagentHandback`. After a refused `SubagentHandback` the coordinator makes no further call and ends the turn with the full report as plain text.
3. The orchestrator reads the last assistant message of the coordinator's output file before it resumes or re-asks the coordinator. It sends all decisions for one block in one message.

Every hand-back names the last relayed message it consumed, by first line and arrival time, or states that it consumed none. A report sent while a child is in flight names each child, and its parent treats the reporter as still running.

Relaying interim reports through `SendMessage` was rejected because its availability varies by session (PR 2602).

The rules are `COORDINATOR-HANDBACK-ONE-REPORT` and `MAIN-AGENT-COORDINATOR-REPORT-READ` in `skills/docs/main-agent-contract.md`. The join stays harness-scoped as issue 2579 landed it (`GATE-EXEC-HARNESS-JOIN`).

## Consequences

The pause and hand-back rules no longer depend on `SendMessage`, whose availability varies by session. The output-file read recovers any refused report. Pi keeps its blocking join and is unchanged. The remaining join and turn-end amendments of issue 2611 land in a later slice and extend this record's amendment of 0056.
