# 0143. Only the full-phase fixer pushes a gate fix commit

## Status

Accepted — 2026-10-12 ([issue 2748](https://github.com/mfittko/dev-loops/issues/2748))

## Context

On a drained PR two gate fix commits reached the PR head before the full-phase fixer ran. The delta agent pushed the first. The second push could not be attributed, although the delta reviewer was briefed not to push. A brief cannot enforce push authority. [0094](./0094-pre-push-reviewer-delta-mode.md) and [0131](./0131-pre-push-delta-thread-route-and-decision-record.md) define the delta sequence, and neither guards the push.

## Decision

- `PRE-PUSH-DELTA-PUSH-AUTHORITY` in the [pre-push review contract](../../skills/docs/pre-pr-review-contract.md) records the rule. `emit-fixer-work-order.mjs --phase commit_only` writes the sequence marker `<main worktree>/tmp/gate-delta/<baseline>.sequence`, whatever `--tmp-root` says, because the pre-push check reads only that location. `--phase full` sets `fullGranted`. The marker records the PR head branch. A marker is active for a tested commit that is the baseline or descends from it, or for any push to the marker's branch (a force-push of a non-descendant sha included), until the remote-tracking ref of that branch advances past the baseline. A marker that names no branch (unreadable or malformed) is never ended by a remote ref; deleting it ends it. A `git merge-base` failure other than "not an ancestor" refuses the push under that marker unless the marker is `fullGranted` (a granted marker is skipped, so a pruned baseline object cannot block later pushes), so the refusal names the marker file. The check tests the pushed shas and their remote refs (the checkout HEAD only when stdin has no ref lines).
- Enforcement is harness-neutral. The generated git `pre-push` hook runs `scripts/loop/check-fix-push-authority.mjs`, which tests each sha git passes on the pre-push stdin and refuses a push of any sha under an active, not granted marker. Pi and Claude Code share this layer. `DEVLOOPS_ALLOW_MAIN` does not bypass it. A parse error or a git failure refuses the push.
- `check-pre-push-delta.mjs --pr-head <sha>` fails closed when the PR head read from GitHub differs from the baseline, so the coordinator detects a head that moved during the sequence.

## Consequences

A stray push during a gate fix sequence is refused on both harnesses. The git layer cannot tell agents apart, so after `fullGranted` it admits any pusher. The delta reviewer brief still states that it MUST NOT push.

The dev-loops side that owns `scripts/` (`ensure-worktree`) passes the script path into the guard install, and the generated `pre-push` hook bakes it. A baked path that is gone (a pruned worktree or cache directory) falls back to the pushing checkout's own `scripts/loop/check-fix-push-authority.mjs`. A hook with neither script refuses a push only under a `*.sequence` marker that is not `fullGranted` and whose branch ref has not advanced past the baseline (or that names no branch), under the main worktree's `tmp/gate-delta` (fail closed), so a consumer install never skips the layer during a sequence. A hook with neither script blocks no push once every marker is granted or its branch ref has advanced, and while such a marker is open it refuses every push from the repository. A reinstall of the default-branch guard hooks adds the layer to an existing checkout.

Residual gaps:

- `git push --no-verify` skips the git layer, and nothing else stops it.
- No dev-loops pre-push hook is installed when `core.hooksPath` is set or a foreign `pre-push` hook exists that the guard does not own. With `core.hooksPath` set the install refuses, and `ensure-worktree` warns that gate fix push authority is not enforced. With a foreign `pre-push` hook the install skips that slot and still returns ok, and `ensure-worktree` warns that gate fix push authority is not enforced. In both cases no push is refused during a gate fix sequence.

Recovery: an abandoned sequence keeps refusing pushes, and the refusal reason and the shell fallback message name the marker file. Delete `<main worktree>/tmp/gate-delta/<baseline>.sequence`. `emit-fixer-work-order.mjs --phase full` grants the push only for a sequence with a clearing delta record (`nextStep: push` or `push_to_gate`). A `commit_only` round that ends without a fix commit clears its own marker when `check-pre-push-delta.mjs` reports that HEAD equals the baseline.
