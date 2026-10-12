# 0143. Only the full-phase fixer pushes a gate fix commit

## Status

Accepted — 2026-10-12 ([issue 2748](https://github.com/mfittko/dev-loops/issues/2748))

## Context

On a drained PR two gate fix commits reached the PR head before the full-phase fixer ran. The delta agent pushed the first. The second push could not be attributed, although the delta reviewer was briefed not to push. A brief cannot enforce push authority. [0094](./0094-pre-push-reviewer-delta-mode.md) and [0131](./0131-pre-push-delta-thread-route-and-decision-record.md) define the delta sequence, and neither guards the push.

## Decision

- `PRE-PUSH-DELTA-PUSH-AUTHORITY` in the [pre-push review contract](../../skills/docs/pre-pr-review-contract.md) records the rule. `emit-fixer-work-order.mjs --phase commit_only` writes the sequence marker `<main worktree>/tmp/gate-delta/<baseline>.sequence`, whatever `--tmp-root` says, because both enforcement layers read only that location. `--phase full` sets `fullGranted`. The marker records the PR head branch. A marker is active for a tested commit that is the baseline or descends from it, until the remote-tracking ref of that branch advances past the baseline. The git layer tests the pushed shas (the checkout HEAD only when stdin has no ref lines) and the Claude hook tests the HEAD of the push target.
- Enforcement is harness-neutral. The generated git `pre-push` hook runs `scripts/loop/check-fix-push-authority.mjs`, which tests each sha git passes on the pre-push stdin and refuses a push of any sha under an active, not granted marker. Pi and Claude Code share this layer. `DEVLOOPS_ALLOW_MAIN` does not bypass it. A parse error or a git failure refuses the push.
- The Claude Bash gate hook adds a per-agent-type check. It refuses a push from every subagent except the fixer after `fullGranted`. The main agent is the operator and is not bound.
- `check-pre-push-delta.mjs --pr-head <sha>` fails closed when the PR head read from GitHub differs from the baseline, so the coordinator detects a head that moved during the sequence.

## Consequences

A stray push during a gate fix sequence is refused on both harnesses. The git layer cannot tell agents apart, so after `fullGranted` it admits any pusher and the Claude hook narrows it to the fixer. Pi has no per-agent layer.

The dev-loops side that owns `scripts/` (`ensure-worktree`) passes the script path into the guard install, and the generated `pre-push` hook bakes it. A baked path that is gone (a pruned worktree or cache directory) falls back to the pushing checkout's own `scripts/loop/check-fix-push-authority.mjs`. A hook with neither script refuses a push only while a `*.sequence` marker exists under the main worktree's `tmp/gate-delta` (fail closed), so a consumer install never skips the layer during a sequence and a pruned script never blocks unrelated pushes. A reinstall of the default-branch guard hooks adds the layer to an existing checkout.

Residual gaps:

- `git push --no-verify` skips the git layer. On Pi nothing else stops it. The Claude hook still denies that command.
- The Claude hook resolves the push target directory from the command and its cwd, and decides on the HEAD of that checkout, not on the pushed refs. A compound command such as `cd <worktree> && git push` is read against the original cwd, and a push of the fix branch by name from another checkout is not caught by the Claude hook. The git layer closes the second case, because it tests the pushed shas. Pi relies on the git layer alone.

Recovery: an abandoned sequence keeps refusing pushes, and both refusal reasons name the marker file. Delete `<main worktree>/tmp/gate-delta/<baseline>.sequence`. `emit-fixer-work-order.mjs --phase full` grants the push only for a sequence with a clearing delta record (`nextStep: push` or `push_to_gate`). A `commit_only` round that ends without a fix commit clears its own marker when `check-pre-push-delta.mjs` reports that HEAD equals the baseline.
