# 0292. The run id resolves from the worktree run-context file, and the gate join heartbeats the runner claim

## Status

Accepted, 2026-11-18 ([issue 3224](https://github.com/mfittko/dev-loops/issues/3224), [PR 3235](https://github.com/mfittko/dev-loops/pull/3235)).

Amends [ADR 0129](./0129-claude-code-gate-join-is-wait-for-units.md) and builds on [ADR 0289](./0289-gate-join-default-tmp-root-and-session-transcript-retro-input.md). ADR 0129 calls the Claude Code join read-only. This record adds one write to it: the runner-claim heartbeat. Every other decision of those records stays in force, and the records stay unedited.

## Context

Under Claude Code, a run id set with `export DEVLOOPS_RUN_ID=...` ends with the Bash call. An inline env prefix no longer matches the `dev-loops-run` allow rules. Commands therefore ran with no run id, the PR runner claim went stale during long CI and gate waits, and `gate upsert-verdict` refused. `gate wait-for-units` did not heartbeat the claim at all. Recovery needed an operator command ([issue 3224](https://github.com/mfittko/dev-loops/issues/3224)).

## Decision

1. `resolveRunId` reads `<worktree>/.pi/dev-loop-run-context.json` through `readRunContext` as its last fallback, after `DEVLOOPS_RUN_ID`, `PI_SUBAGENT_RUN_ID` and the native Pi synthesis. It reads the file from the worktree root of the command's working directory. On native Codex the verified thread identity keeps precedence over the file.
2. `loop startup --claim` calls `ensureRunId` with the worktree root. It mints a run id and writes the file only when no run id resolves. No command gains a `--run-id` flag.
3. A plan wait of `gate wait-for-units` heartbeats the PR runner claim once per heartbeat window, as `probe-ci-status` does. `--artifact` mode stays read-only. A failed heartbeat never changes the wait outcome.
4. `GATE-EXEC-HARNESS-JOIN` in `skills/docs/gate-review-sub-loop-contract.md` states that the coordinator starts the join from the lane's linked worktree, as `dev-loops-run --repo-root <worktree> cli/index.mjs gate wait-for-units ...`, with no `--tmp-root` (ADR 0289). A main-checkout working directory resolves no run id, and the heartbeat is then a no-op.

## Consequences

- A Claude Code lane keeps its runner claim fresh across long waits with no environment variable and no operator command.
- The join is no longer strictly read-only. Its only write is the claim heartbeat of the plan's PR.
- A join started from the main checkout still waits correctly, but it does not refresh the claim.
