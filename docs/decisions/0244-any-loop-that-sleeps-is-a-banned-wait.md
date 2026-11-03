# 0244. Deny any shell loop that sleeps as a banned wait

## Status

Accepted — 2026-11-03 ([issue 3028](https://github.com/mfittko/dev-loops/issues/3028))

## Context

Issue [3028](https://github.com/mfittko/dev-loops/issues/3028) reports workers that polled for hours. They ran `until grep -q ...; do sleep 3; done` and `until ! pgrep -f "bun test ..."; do sleep 5; done`. The `pgrep -f` form never ends, because `pgrep -f` matches the loop's own command line. The old ban covered only `gh` and loop-state polls and file-marker polls, so neither loop was denied. The harness already notifies the agent when a background command exits, so a sleep loop has no use that a sanctioned wait does not cover.

## Decision

- `COPILOT-FOLLOWUP-WAIT-TOOLS` denies any `while`, `until`, or `for` loop whose body runs `sleep`, whatever the loop condition is.
- The predicate `commandIsSleepLoop` in `packages/core/src/loop/bash-command-classify.mjs` reads the `tokenizeShellCommand` segments. Quoted literals and heredoc bodies stay allowed, because the tokenizer does not report them as command heads.
- Sanctioned waits stay allowed: `wait-pr-checks.mjs`, `probe-copilot-review.mjs`, `gh run watch` with an explicit timeout, and the harness exit notification for a background command.
- Claude Code enforces the rule now. Pi inherits the shared predicate when the Pi Bash-gate deny-set slices land. A row in the [cross-harness regression contract](../../skills/docs/cross-harness-regression-contract.md) records this split.
- The deny reason text lives in the operator-guarded hook decision file. Only the operator changes that text.
- Rejected: extending the old ban with more condition patterns (`grep`, `pgrep`, `test -f`). Each new poll shape would need a new pattern, and the hours-long loops in issue 3028 used conditions the old ban did not name.

## Consequences

The check reads the whole command: a loop head anywhere plus a `sleep` head anywhere denies it. A benign command that pairs an unrelated loop with a separate `sleep` must split into two calls. A loop inside a backtick command substitution is not detected; this is an accepted gap. Pi has no enforcement until its deny-set slices land.
