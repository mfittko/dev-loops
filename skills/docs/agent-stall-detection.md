# Agent-level stall detection → auto-fresh-dispatch

Issue: #1669. Owner: `dev-loop` (applies to the `local_implementation` and
routed `dev-loop` subagent dispatch paths under Pi; harness-agnostic core).

## Problem

The rc.5 drive needed 5 interrupt+resume interventions to recover stalled
dev-loop subagents (#1507 thrash, #1526 hung test, #1537 hung watch, #1525
hung watch+scale, #1485 GLM stall×2). Interrupt+resume was correct but
high-latency — it cost a full idle-timeout round-trip. #1631/#1633 handled
stall detection at the CI/resume and runner-claim layers; the **agent-level**
stall → auto-fresh-dispatch threshold was still missing.

This contract adds the deterministic agent-level stall detector and documents
the auto-fresh-dispatch procedure the parent follows when a child is judged
stalled.

## What "stalled" means

A dev-loop child (subagent) is **stalled** when:

- it shows **no turn progress** for N minutes (default 5, `workflow.stallDetection.thresholdMinutes`), AND
- it has **no pending supervisor request** (a blocked child is waiting legitimately), AND
- it is **not** in a sanctioned long watch.

## What is NOT a stall

- A **pending supervisor request** (`contact_supervisor`/`intercom ask` is
  unanswered) — the child is blocked waiting, never stalled.
- A **sanctioned long watch** — an active bash/subagent tool call that
  heartbeats its runner claim (`assertRunnerOwnership` / watch-cycle). Only
  sanctioned long waits refresh the runner-coordination `activeRun.updatedAt`,
  so a fresh heartbeat proves the run is legitimately busy waiting, not stalled.

## Config surface

```yaml
# .devloops (repo root)
workflow:
  stallDetection:
    enabled: true            # false restores the old wait behavior
    thresholdMinutes: 5      # no-turn-progress window before a child is stalled
```

Defaults: `enabled: true`, `thresholdMinutes: 5`. Resolved via
`resolveWorkflowConfig(config, "stallDetection")` from `@dev-loops/core/config`.

## Detector

The deterministic detector is a pure, harness-agnostic function in
`@dev-loops/core/loop/agent-stall`:

- `detectAgentStall({ lastActivityAt, sanctionedWatchAt, pendingRequest, now,
  thresholdMs })` → `{ status, reason, stalled, turnAgeMs, watchAgeMs,
  thresholdMs }`
  - `status`: `stalled` | `not_stalled` | `no_evidence`
  - exempt reasons: `pending_request`, `sanctioned_watch`, `active_turns`
  - `buildAgentStallRecoveryBrief(...)` shapes the recovery brief for a
    fresh-context dispatch (carries the run id, worktree path, and last known
    action).
- `resolveAgentStallThresholdMs(thresholdMinutes)` → ms (default 5 min).

## CLI probe

`node scripts/loop/detect-agent-stall.mjs --repo <owner/name> [--pr <n>]
[--status <path> | --session <path>] [--threshold-min <n>]
[--pending-request] [--pending-marker <path>] [--run-id <id>] [--cwd <path>]
[--last-action <text>]`

- Turn signal: async run `status.json` `lastActivityAt`/`lastUpdate`, else the
  `session.jsonl` mtime.
- Sanctioned-watch heartbeat: runner-coordination `activeRun.updatedAt`
  (only when `--pr` is given).
- Emits a structured verdict plus the recovery brief.

## Auto-fresh-dispatch procedure (parent)

When the parent needs to decide whether a child has stalled:

1. Run the probe. If `status: stalled` and `workflow.stallDetection.enabled`:
2. Bail the current child (record its exit; do not trust the lock heartbeat
   alone — verify the child via status/transcript/process before overriding any
   ownership).
3. Dispatch a fresh-context child carrying `recoveryBrief` (worktree path, run
   id, last known action). The fresh child resumes from the last known action
   rather than restarting from scratch.
4. Log the stall + recovery under `tmp/`.

If a genuine fan-out cannot produce evidence in a child-safe environment, stop
and surface to the operator — do not auto-inline (see the gate sub-loop
contract).

## Non-goals

- Replacing interrupt+resume (that remains the manual fallback).
- Detecting stalls inside a single tool call (bounded by #1650/#1660).
- Detecting stalls at the CI/runner-claim layer (that is #1631/#1633).
