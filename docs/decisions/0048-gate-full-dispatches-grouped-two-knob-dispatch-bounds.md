# 0048. `gate:full` dispatches grouped; two-knob fan-out dispatch bounds

## Status

Accepted — 2026-08-07 ([issue 1601](https://github.com/mfittko/dev-loops/issues/1601))

Partially amends [0047](./0047-grouped-fanout-dispatch-default.md): the `gate:full`
per-angle restoration clause is superseded. 0047's grouped-default, static-grouping
table, and per-angle opt-in (`mode: per-angle`) are unchanged.

## Context

0047 made grouped fan-out the default and kept `gate:full` (label or
`mode: per-angle`) as the sanctioned full-scrutiny escalation that "ungroups
every angle back to 0039's original shape" — one reviewer per angle. Driving
PR #1598 (issue #1588) to merge during the rc.4 cycle exposed the cost of that
per-angle restoration on multi-angle gate rounds: a 9-angle draft_gate + 7-angle
pre_approval_gate round fires 7–9 concurrent reviewer subagents with no
concurrency cap on the gate fan-out path, and the model/API provider returns
**429 (too many concurrent requests)**. The dev-loop recovers reactively (retry
failed angles in smaller batches, then foreground one-at-a-time), but the 429
storm + retries + cleanup wastes cycles and tokens on every multi-angle round.

Root cause: `gate:full`/`mode: per-angle` force per-angle dispatch (one
reviewer per angle), and ungrouped angles dispatch as singletons, so a
multi-angle round launches one concurrent reviewer per angle with no cap on the
gate fan-out path. The local review-mode cap (`selectReviewerPlan`,
`DEFAULT_REVIEW_MAX_PARALLEL = 3`) does not apply to the gate fan-out, and no
`.devloops` knob bounded the gate fan-out's concurrency.

## Decision

Two orthogonal, configurable dispatch bounds (operator decision, 2026-08-07).
Both count **dispatch units** (groups), not angles — a group of N angles is one
concurrent unit.

1. **`gates.fanout.maxAnglesPerGroup`** (N, integer, min 1, default 3).
   `resolveFanoutGroups` (`@dev-loops/core/config`) auto-chunks the leftover
   ungrouped angles (after configured-groups matching, unchanged) into dispatch
   units of ≤ N with deterministic order and stable unit names, instead of
   one singleton per leftover angle. `mode: per-angle` is retained as the exact
   equivalent of `maxAnglesPerGroup: 1` (one singleton unit per angle, bypassing
   the configured-groups table). `gate:full` no longer restores per-angle
   dispatch: it keeps forcing the **full angle set** upstream
   (`resolveGateTier` returns `gate_full_label`, so `resolveGateAnglesDynamic`
   skips diff-class tier reduction) and dispatches **grouped** — the configured
   groups are matched first, then the leftover pool is auto-chunked into units of
   ≤ N. This supersedes 0047's `gate:full` per-angle restoration clause.

2. **`gates.fanout.maxConcurrent`** (M, integer, min 1, default 4). The gate
   fan-out conductor dispatches at most M dispatch units concurrently per wave,
   reusing the existing wave scheduler `scheduleParallelWaves`
   (`@dev-loops/core/loop/queue-parallel`). `write-gate-context.mjs` emits the
   deterministic wave plan (groups + `wavePlan` + both knobs) alongside the
   per-unit briefings in the gate-context artifact, and the conductor dispatches
   wave-by-wave — awaiting a free slot (wave completion) before launching the
   next — instead of fire-all-then-retry.

3. **Adaptive 429 backoff.** When a reviewer dispatch 429s despite the cap, the
   conductor does NOT fail-and-requeue the whole angle: it halves the active
   batch (`backoffMaxConcurrent` from `@dev-loops/core/loop/gate-fanin`),
   recomputes the wave plan, and retries the failed dispatch before escalating to
   foreground one-at-a-time fallback. The backoff is recorded in the round's
   provenance.

4. **Per-group, not per-angle.** Both bounds count dispatch units (groups), not
   angles. Fan-out provenance thresholds already derive from fresh dispatch
   units (`countFreshDispatchUnits`, `@dev-loops/core/loop/gate-fanin`), so
   `requireFanoutProvenance` expectations follow the grouping automatically — no
   provenance-mechanism change. A multi-angle chunk counts as one dispatch unit
   (one reviewer), so the `distinctReviewers` floor scales with what was
   actually dispatched, and `fanoutReviewerPairingError`'s within-group exception
   honors a chunk's shared reviewer identity.

5. **Defaults ship in the zod schema / `extension-defaults.yaml`;** this repo
   inherits them (no `.devloops` override needed unless the operator wants
   tighter bounds).

Rejected: dynamic/heuristic grouping (defeats the auditability a static table
gives a reviewer of the contract — unchanged from 0047); removing the per-angle
opt-in entirely (`mode: per-angle` stays as the ≡ N=1 escape hatch); a single
concurrency knob without the grouping knob (grouping is what reduces the unit
count the concurrency cap bounds — the two are orthogonal and both are needed).

## Consequences

A multi-angle gate round now dispatches grouped units of ≤ N angles, at most M
concurrently, instead of N concurrent singletons with no cap. The 429 storm on
#1588's drive shape (7–9 concurrent reviewers) is bounded to M (default 4)
concurrent dispatch units; a 9-angle round with default N=3 is at most 3
dispatch units, dispatched 3 + 0 or fewer per wave. `gate:full` keeps forcing
the full angle set (no diff-class tier reduction) but no longer multiplies
concurrent reviewers one-per-angle — its scrutiny escalation is the full angle
set, not the per-angle dispatch shape. The `fullLabel` parameter on
`resolveFanoutGroups` is retained on the signature (callers thread it) but is a
no-op for dispatch shape; its angle-set effect lives upstream in
`resolveGateTier`. A reviewer who wants the un-grouped signal opts in via
`mode: per-angle` (≡ N=1). Provenance, fan-in, the disposition ledger, coverage
checks, and the head-stamp guard are all unchanged — they were already
angle-keyed / dispatch-unit-keyed, not reviewer-count-keyed. The adaptive 429
backoff is a conductor procedure backed by `backoffMaxConcurrent` +
`scheduleFanoutWaves` (deterministic, testable); it does not change the
provenance mechanism, only records the backoff event in the round's provenance.
