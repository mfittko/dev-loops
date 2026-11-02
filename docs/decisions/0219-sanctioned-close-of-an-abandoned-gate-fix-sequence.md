# 0219. Sanctioned close of an abandoned gate fix sequence

## Status

Accepted, 2026-11-01 ([issue 2999](https://github.com/mfittko/dev-loops/issues/2999), parent [issue 2841](https://github.com/mfittko/dev-loops/issues/2841)).

Amends ADR 0143 and ADR 0213. Accepted records remain unchanged.

Amended by [ADR 0228](0228-close-sequence-admission-is-atomic-and-liveness-is-activity-based.md) for the command spelling (`dev-loops-run cli/index.mjs gate close-sequence ...`), the grace period (the runner TTL, `resolveStaleRunnerMaxAgeMs`) and the activity-based liveness rule.

## Context

Under `PRE-PUSH-DELTA-PUSH-AUTHORITY`, a gate fix sequence writes the marker `tmp/gate-delta/<baseline>.sequence`. While the marker is active and not granted, the `pre-push` hook refuses pushes to the marker's branch. A sequence can be abandoned: the fixer is never dispatched, the fixer dies, or the PR head moves outside the loop. The abandoned marker then locks pushes. Before this record, the only recovery was to delete the marker file by hand, and the refusal reason told the operator to do that. An agent had no sanctioned way to end the lock.

## Decision

`dev-loops gate close-sequence --head <baseline> --repo <owner/name> --pr <number>` (`scripts/loop/close-gate-sequence.mjs`) closes a marker only when it proves one abandonment condition from authoritative state:

- `HEAD_MOVED`: the PR head read from GitHub differs from the marker baseline, on the branch the marker names.
- `FIXER_NEVER_PULLED`: the marker names a fixer execution, no pull receipt exists for its work order, and the marker is at least 30 minutes old.

The 30 minute grace equals the runner-lock TTL. A dispatch or a fixer younger than the grace may be live.

A live sequence is never cleared. The command refuses `sequence_live`, `fixer_running`, `abandonment_unproven`, `baseline_unknown` and `sequence_absent`, and each refusal names a remedy. `baseline_unknown` applies to a marker that names no work order ref when its baseline is not a commit in the local repository. The remedy is to run the close from a checkout of the marker's repository, or to ask the operator to delete the marker. A fixer that pulled its work order and has not handed back within the grace reads as running. An unreadable pull receipt also reads as running. A marker rewritten while the PR head is read starts a new sequence and is refused.

The command writes the closure record `gate-delta/<baseline>.sequence-closed.<execution|none>.json` before it removes the marker. A failed write leaves the marker in place. A marker without an execution writes the suffix `none`, and a later execution-less close on the same head overwrites that record. The record names the baseline, the execution, the condition, the actor and the time. `emit-fixer-work-order.mjs` reads the record, so a later pull of the closed execution's work order is refused as `stale_dispatch`. The marker now carries the fixer execution identity so the command can bind the receipt and the record to one execution.

The closure record is audit evidence. It is never gate evidence under `PRE-PUSH-DELTA-NOT-GATE-EVIDENCE`. It does not satisfy a gate round, a verdict or merge readiness. The next pushed head still gets a full gate round.

An operator-typed close marker was rejected. Agents must never write operator-owned markers (`OPERATOR-OWNED-LINE`, [ADR 0130](./0130-comment-wrappers-refuse-operator-owned-lines.md)), so such a marker would leave the agent with no recovery path. The proven-abandonment conditions let an agent close the lock without operator authority, because they only release a sequence that no fixer can still complete.

## Consequences

An agent recovers an abandoned sequence without hand deletion. The refusal reason of `check-fix-push-authority.mjs` now points at the command.

Residuals:

- A fixer that pulled its work order and then died leaves a receipt. With the PR head unchanged, the command refuses that marker. It clears only after the head moves, or when the operator deletes the marker.
- A never-pulled dispatch blocks pushes for up to 30 minutes before the command can close it.
- A fork that shares git objects with the marker's repository can satisfy the local commit check of `baseline_unknown`. That check guards against a wrong checkout and does not prove repository identity.
- A marker that names no branch cannot be proven abandoned, so the operator deletes it. A marker that names no execution clears only through a moved head.
