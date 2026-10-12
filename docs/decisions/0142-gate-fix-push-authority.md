# 0142. Only the full-phase fixer pushes a gate fix commit

## Status

Accepted — 2026-10-12 ([issue 2748](https://github.com/mfittko/dev-loops/issues/2748))

## Context

On a drained PR two gate fix commits reached the PR head before the full-phase fixer ran. The delta agent pushed the first. The second push could not be attributed, although the delta reviewer was briefed not to push. A brief cannot enforce push authority. [0094](./0094-pre-push-reviewer-delta-mode.md) and [0131](./0131-pre-push-delta-thread-route-and-decision-record.md) define the delta sequence, and neither guards the push.

## Decision

- `PRE-PUSH-DELTA-PUSH-AUTHORITY` in the [pre-push review contract](../../skills/docs/pre-pr-review-contract.md) records the rule. `emit-fixer-work-order.mjs --phase commit_only` writes the sequence marker `<tmp-root>/gate-delta/<baseline>.sequence`. `--phase full` sets `fullGranted`.
- Enforcement is harness-neutral. The generated git `pre-push` hook runs `scripts/loop/check-fix-push-authority.mjs`, which refuses every push while a marker is active and not granted. Pi and Claude Code share this layer. `DEVLOOPS_ALLOW_MAIN` does not bypass it. Git failures refuse the push.
- The Claude Bash gate hook adds a per-agent-type check. It refuses a push from every subagent except the fixer after `fullGranted`. The main agent is the operator and is not bound.
- `check-pre-push-delta.mjs --pr-head <sha>` fails closed when the PR head read from GitHub differs from the baseline, so the coordinator detects a head that moved during the sequence.

## Consequences

A stray push during a gate fix sequence is refused on both harnesses. The git layer cannot tell agents apart, so after `fullGranted` it admits any pusher and the Claude hook narrows it to the fixer. Pi has no per-agent layer. A consumer checkout without the script skips the git layer. A reinstall of the default-branch guard hooks adds the layer to an existing checkout.
