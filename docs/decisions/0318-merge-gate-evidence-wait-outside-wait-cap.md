# 0318. The merge gate-evidence wait sits outside the wait cap

## Status

Accepted — 2026-11-22 ([PR 3456](https://github.com/mfittko/dev-loops/pull/3456), [issue 3411](https://github.com/mfittko/dev-loops/issues/3411)).

## Context

`GATE-EXEC-BOUNDED-WAIT-CAP` caps a foreground wait in a subagent call, because Claude Code moves a long foreground call of a subagent to the background. `scripts/github/merge-pr.mjs` has a `gate_evidence_run` check. When the Gate evidence run is still in progress, the check must wait for it. [Issue 3411](https://github.com/mfittko/dev-loops/issues/3411) (`ac:1`) requires that wait to be bounded. Before the wait existed, the orchestrator watched the run by hand and retried the merge, and three merges each failed once and merged on the retry.

## Decision

The `gate_evidence_run` wait of `merge-pr.mjs` (bound 540 s, poll interval 15 s) is outside `GATE-EXEC-BOUNDED-WAIT-CAP`. The cap protects subagent calls. Only the orchestrator runs `merge-pr.mjs`, with or without `--check`, and every subagent run stays denied ([ADR 0297](0297-subagent-may-run-merge-test-files.md)). The orchestrator is the main session, so no subagent call exists for Claude Code to background. The wait ends at the bound, so it meets `ac:1`. The [gate review sub-loop contract](../../skills/docs/gate-review-sub-loop-contract.md) lists the exception beside the other uncapped waits.

Rejected alternatives:

1. A capped wait that returns a `pending` outcome and a reissue instruction. It needs more calls and more code, for the one caller that the cap does not target.
2. The manual watch and retry. The orchestrator watched three merges that each failed once and merged on the retry.

## Consequences

`merge-pr.mjs` holds one foreground call for up to 540 s and has no `pending` outcome. A 540 s foreground call in the main session was not tested live. The 540 s bound is the same one that `scripts/loop/spec-context.mjs` uses for its rate-limit wait. If Claude Code backgrounds a main-session call of that length, the orchestrator must move this wait under the capped pattern with a new ADR that supersedes this record.
