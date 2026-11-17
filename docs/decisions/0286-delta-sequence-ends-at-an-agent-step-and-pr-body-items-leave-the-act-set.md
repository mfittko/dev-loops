# 0286. A delta sequence ends at an agent step, and PR-body act items leave the delta act set

## Status

Accepted, 2026-11-16 ([issue 2447](https://github.com/mfittko/dev-loops/issues/2447), slice 1 of 11; evidence: PR 3221 needed two manual marker deletions, and the targeted tests in `test/loop/close-gate-sequence.test.mjs`, `test/loop/emit-fixer-work-order.test.mjs`, `test/loop/seal-evidence.test.mjs` and `packages/core/test/pre-push-delta-review.test.mjs` pass).

Amends [ADR 0219](./0219-sanctioned-close-of-an-abandoned-gate-fix-sequence.md) and [ADR 0229](./0229-close-sequence-admission-is-atomic-and-liveness-is-activity-based.md): the close conditions and the removed operator-delete remedy. Every other decision of those records stays in force, and both records stay unedited.

## Context

Three paths in the delta sequence ended at an operator `rm` of `tmp/gate-delta/<sha>.sequence`, or at a `bounded_out` with no real defect left (PR 3221, 2026-11-16).

- The delta reviewer reads repository files only, so it marks a PR-body act item `cannot_verify`. The item can never be `resolved`, and the third invocation ends `bounded_out`.
- `--result` downgrades a `locally_clear` result with a `cannot_verify` item to `bounded_out`/`push_to_gate`. The `--phase full` emitter then re-ran the outcome check under `membershipOnly` and refused the sealed result it had accepted as a record.
- `gate close-sequence` closed only `HEAD_MOVED` and `FIXER_NEVER_PULLED`. A fixer that pulled its order, committed and handed back left a `sequence_live` marker even when its sealed record was `bounded_out`/`push_to_gate`. Several refusals told the operator to delete the marker.

## Decision

1. PR-body act items leave the delta act set. `startDeltaSequence` drops each act item that names no file, the predicate of [ADR 0271](./0271-body-only-cap-round-exit.md) (`resolveFindingFile`), except a review-thread item, whose ref is the thread id that the full-phase binding checks. The act set id, the site coverage and the reviewer input cover the remaining items. The input run prints the dropped refs as `bodyItems`. An act list of only such items refuses `delta_body_only_act_set` and names `scripts/github/edit-pr.mjs` and the ADR 0271 body-only converged post. `emit-fixer-work-order.mjs --phase commit_only` refuses `delta_body_only_act_set` for an act list of only PR-body items and writes no marker. The next gate round verifies the body edit. No delta check does.
2. `validateDeltaResult` runs the outcome-consistency check only when `membershipOnly` is false. `--phase full` keeps its record checks and accepts a sealed `bounded_out`/`push_to_gate` record at invocation 3. A `--phase full` refusal for a HEAD past the record's candidate names the authenticated `head_moved` closure of `check-pre-push-delta.mjs`. `composeConvergedDraftGate` checks its own outcome, because it relied on the skipped check.
3. `close-sequence` adds the condition `BOUNDED_OUT`. It holds when the sealed delta record of the marker baseline holds `outcome: bounded_out` and `nextStep: push_to_gate`, the record's `origin` names the marker's work order and execution, the PR head still equals the baseline, and the fixer is not running. The close writes the closure record with that condition, removes the marker and returns `nextStep: push_to_gate`, which names the `--phase full` emission.
4. `close-sequence` adds the condition `MARKER_UNREADABLE`. It holds for a marker that is unreadable, names no branch, or sits under a name that is not a full hex SHA, after the fixer-running check, when `--repo` and `--pr` are given. An unreadable or non-object pull receipt reads as a pull whose activity time is the receipt file mtime, so it ages out of the grace like any other pull. `baseline_unknown` names only the rerun from a checkout of the marker's repository. No remedy names a marker delete or an operator step.
5. The reviewer result schema forbids `locally_clear` while any item is not `resolved`. The emitted `resultShape.outcome` states the constraint. `seal-evidence.mjs --kind delta` runs the sequence-free shape checks of `validateDeltaResult` (`deltaResultShapeErrors`) and refuses `evidence_malformed` before it seals, so the reviewer corrects its own unsealed result and a shape error consumes no invocation.

## Consequences

An agent ends every delta sequence with a command. A bounded-out sequence closes with `gate close-sequence`, and the full phase pushes the committed candidate into the gate round. A PR-body finding goes to the PR body and the next gate round, so it no longer consumes delta invocations.

Residuals:

- A PR-body item is no longer checked inside the delta sequence. A body edit that does not resolve it surfaces in the next gate round.
- `BOUNDED_OUT` relies on `origin` in the sealed record. A thread-route record carries no `origin`, so its sequence closes through `HEAD_MOVED` or `no_commit` as before.
- The CLI accepts `--head` as a full SHA or a safe marker file name (`^[A-Za-z0-9._-]{1,128}$`, never `.` or `..`), and a non-hex name routes only to `MARKER_UNREADABLE`. A marker whose name is empty, longer than 128 characters or has any character outside that set cannot be closed by the CLI.
- The `MARKER_UNREADABLE` close checks the work order owner (`--repo` and `--pr`) like every other condition, and a receipt object with no parseable `pulledAt` counts its file mtime as the pull time.
- A no-branch marker that names a pulled execution has no branch reflog activity signal, so only the pull time counts. A fixer still committing more than one grace after its pull reads as stopped and its marker closes. A handback requirement would leave a dead fixer's marker uncloseable, so the residual stays named.
- A mixed code and PR-body act list at the cap round converges only when the live PR body digest differs from the reviewed `pr-body` read (`body_unchanged`, `body_read_unrecorded`), the check of the body-only route. Whether the edit resolves an item stays with the next gate round.
- A file-less act item that is a code issue routes to the PR body, the ADR 0271 predicate. `startDeltaSequence` rejects an explicit ref that appears in both the body and the code sublist.
- A marker that does not parse names no execution, so `MARKER_UNREADABLE` recovers the execution and fixer branch from the PR's emit plan when that plan was emitted for the marker's baseline, and runs the pull-receipt and fixer-running checks before and under the sequence lock. With no such plan only marker age and the sealed-record check apply, and the closure record stays keyed `none`.
- `MARKER_UNREADABLE` closes only once the marker is as old as the dispatch grace, like `FIXER_NEVER_PULLED`. A younger marker refuses `abandonment_unproven` with a rerun remedy.
