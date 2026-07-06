# Steering Contract

Canonical owner for the deterministic mid-flight operator steering contract for
active dev loops: how to submit steering directives, how the loop acknowledges
them, the safe-point rules, and what each result means. In the first external
slice, steering is a bounded mutation layer layered on top of the read-only
inspection snapshot for one active Copilot PR outer-loop run.

## Overview

Once a dev loop is running, operators can issue a **bounded, durable steering
directive** to tighten or redirect the run — without restarting it and without
silently editing prompts. Each directive receives a deterministic
acknowledgement/result so you always know whether a correction took effect.

**This is not arbitrary prompt injection.** Steering events are schema-validated,
sequenced, persisted to durable run state, and applied only at safe points. You
can inspect the full history at any time.

## First proving target

The first implementation of this contract covers the **async Copilot review/fix
loop** (`copilot-loop-state.mjs`). The safe-point rules and integration below
are defined for that loop family. Other loop families will adopt the same contract
in subsequent work.

## Implementation

| Component | Location |
|---|---|
| Core steering module | `packages/core/src/loop/steering.mjs` |
| CLI entry-point | `scripts/loop/steer-loop.mjs` |
| Core unit tests | `packages/core/test/steering.test.mjs` |
| CLI integration tests | `test/loop/steer-loop.test.mjs` |
| **Loop integration (read-only overlay)** | `scripts/loop/detect-copilot-loop-state.mjs` (via `--steering-state-file`) |
| Loop integration tests | `test/loop/detect-copilot-loop-state.test.mjs` (steering section) |

---

## First-slice external directive boundary

<!-- rule: STEERING-EXTERNAL-SCOPE-NARROW -->
The first external operator-facing `submit` contract is intentionally narrow:

- it targets one explicit Copilot PR outer-loop run at a time
- it reuses the inspection identity model (`repo` + `pr` ⇒ `runId: pr-<number>`)
- it MUST accept exactly one behavior-changing directive:
  `stop_at_next_safe_gate`
- it MUST reject `hard_constraint`, `preference`, and `clarification` on the
  external submit path

The lower-level core/state surfaces may still model other steering kinds, but
they are not part of the v1 operator-facing submit contract.

---

## Steering kinds

| Kind | Meaning |
|---|---|
| `hard_constraint` | A hard requirement that must be respected by subsequent steps. Additive: multiple constraints stack. Exact duplicates (case-insensitive) are rejected. |
| `preference` | A preference that should be followed but is not blocking. Multiple preferences accumulate on the effective stack. |
| `clarification` | Additional context that does not change requirements but affects how the loop interprets its task. |
| <!-- term: gate:stop_at_next_safe_gate --> `stop_at_next_safe_gate` | Request the loop to stop at the next safe approval/mutation gate instead of continuing to the next loop step. |

---

## Acknowledgement / result classes

Each submitted steering event receives exactly one of the following results:

| Result | Meaning |
|---|---|
| `applied_now` | The directive was immediately added to the effective stack. The loop will respect it from the current step forward. |
| `queued_for_safe_point` | The loop is currently in a state where immediate application could produce inconsistent behavior. The directive is durably queued and will be promoted to the effective stack when the loop next reaches a safe point. |
| `rejected_unsafe_now` | The loop is in a terminal state (`done`, `review_request_unavailable`, `no_pr`). Steering has no effect and is rejected. The run must be restarted for a fresh steering session. |
| `rejected_invalid_or_conflicting` | The event was malformed (missing required fields), the `seq` value was out of order, or the directive exactly duplicates an existing `hard_constraint` already on the effective stack. |
| `needs_human_decision` | The loop is in `blocked_needs_user_decision`. A human must act on the blocking condition before automated steering can be applied. |

---

## Observation vs control boundary

- `scripts/loop/inspect-run.mjs` owns the read-only run snapshot and the
  run-scoped steering readback summary relevant to current state
- `scripts/loop/steer-loop.mjs submit` owns bounded mutation and returns an
  acknowledgement immediately; it does not wait for later promotion
- `scripts/loop/steer-loop.mjs status` owns steering-specific acknowledgement
  history beyond the inspection summary

This first slice does **not** attach to the live worker or introduce a generic
conductor-wide control plane.

### Live-steering advertisement contract

<!-- rule: STEERING-LIVE-ADVERTISEMENT-FAIL-CLOSED -->
`inspect-run` MUST fail closed for live-steering availability:

- a steering file can be present while live steering is still unavailable
- `layers.steering.status: "available"` is only valid when inspection evidence is
  live-detector-backed + authoritative and free of stale/missing/conflict markers
- when those conditions are not met, `layers.steering.status` is
  `"unavailable"` with a stable machine-readable reason such as:
  - `live_steering_unavailable_source_mode`
  - `live_steering_unavailable_trust`
  - `live_steering_unavailable_markers`
  - `live_steering_unavailable_unknown_state`
  - `live_steering_unavailable_terminal_state`
- terminal/non-running loop states must fail closed even when a steering file is present;
  a steering locator alone must not imply that live steering is usable

`steer-loop submit` should preserve the same fail-closed shape for steering
attempts with stable machine-readable `reasonCode` values (for example
`inspection_not_authoritative`) whenever operator-facing steering is rejected
before mutation.

---

## Safe-point model

The safe-point classification for each copilot loop state determines whether
steering is applied immediately, queued, or rejected.

### IMMEDIATE (steering applied now)

The loop is between steps, idle, or waiting on external state. Applying steering
here is safe: no mutation is in progress.

| Loop state | Reason |
|---|---|
| `pr_ready_no_feedback` | Idle — no review has been requested yet |
| `ready_to_rerequest_review` | Between review cycles — all threads resolved, waiting for next pass |
| `waiting_for_copilot_review` | Waiting on external state (Copilot) |
| `waiting_for_ci` | Waiting on external state (CI checks) |

### NEXT_POINT (queued for next safe point)

The loop is actively computing or in the middle of a non-interruptible mutation.
Steering is accepted and queued; it is promoted to the effective stack the next
time the loop reaches an IMMEDIATE state.

| Loop state | Reason |
|---|---|
| `pr_draft` | Pre-review state — between steps but not at a mutation gate |
| `unresolved_feedback_present` | Actively computing — about to apply fixes |
| `already_fixed_needs_reply_resolve` | Non-interruptible mutation — replying to and resolving review threads |

### TERMINAL (rejected)

The loop run is complete, irreversibly failed, or has no active run. There is no
loop to steer.

| Loop state | Result |
|---|---|
| `no_pr` | `rejected_unsafe_now` — no active run |
| `done` | `rejected_unsafe_now` — run already complete |
| `review_request_unavailable` | `rejected_unsafe_now` — terminal error state |
| `blocked_needs_user_decision` | `needs_human_decision` — human action required first |

---

## Durable run state

Steering state is persisted to a JSON file so subsequent loop steps and
resumptions see the updated constraints.

Default paths:

```text
operator-facing --repo/--pr mode: .pi/steering/<owner>/<repo>/pr-<n>.json
low-level --run-id mode:          .pi/steering/<run-id>.json
```

You can override this with `--state-file <path>`.

### State schema

```json
{
  "runId": "string",
  "schemaVersion": 1,
  "target": null, /* low-level --run-id mode; operator-facing --repo/--pr mode stores { "repo": "owner/name", "pr": 55 } */
  "events": [ /* all submitted events, in submission order */ ],
  "effectiveStack": [ /* events currently in effect */ ],
  "queuedEvents": [ /* events waiting for the next safe point */ ],
  "resultHistory": [ /* all acknowledgement results, in order */ ],
  "latestResult": { /* most recent acknowledgement, or null */ },
  "nextSeq": 3
}
```

---

## Ordering and sequencing

<!-- rule: STEERING-SEQ-MONOTONIC -->
Every steering event carries a `seq` field — a positive integer that MUST be
monotonically increasing per run. The loop enforces this:

- If `seq < nextSeq`, the event is rejected with `rejected_invalid_or_conflicting`.
- After a successful submission (any result), `nextSeq` advances to `max(nextSeq, seq + 1)`.

This ensures a durable ordering that survives serialization, process restarts, and
replay.

---

## Conflict behavior

<!-- rule: STEERING-HARD-CONSTRAINT-DEDUP -->
For `hard_constraint` events: two constraints with **different** directives are allowed and
stack additively; an event with an **identical** directive (case-insensitive) to one already
on the effective stack MUST be rejected with `rejected_invalid_or_conflicting`, and the reason
MUST include the seq number of the existing constraint.

`preference`, `clarification`, and `stop_at_next_safe_gate` events do not conflict
with each other in v1; they accumulate additively.

---

## What happens when steering arrives during a non-interruptible mutation?

`already_fixed_needs_reply_resolve` is a multi-step GitHub mutation that must complete
atomically — interrupting it could leave threads half-resolved. Per the NEXT_POINT table
above, steering submitted there (or during `unresolved_feedback_present`, which is about to
apply code fixes) is **queued** (`queued_for_safe_point`) and promoted automatically when
the loop next reaches an IMMEDIATE safe point (e.g. `ready_to_rerequest_review`).

---

## Operator usage

### Submitting a directive

```sh
node scripts/loop/steer-loop.mjs submit \
  --repo <owner/name> \
  --pr <number> \
  --kind stop_at_next_safe_gate \
  --directive "Stop before the next safe gate" \
  --seq 1 \
  [--state-file .pi/steering/<owner>/<repo>/pr-<n>.json]
```

**Required flags:**

| Flag | Description |
|---|---|
| `--repo` | Repository slug |
| `--pr` | Pull request number |
| `--kind` | Must be `stop_at_next_safe_gate` in the external operator-facing contract |
| `--directive` | Operator payload / directive text (non-empty) |
| `--seq` | Positive integer sequence number (must be >= current `nextSeq`) |

**Optional flags:**

| Flag | Default | Description |
|---|---|---|
| `--run-id` | derived as `pr-<number>` | Optional explicit identity check; mismatches are rejected |
| `--state-file` | repo/pr mode: `.pi/steering/<owner>/<repo>/pr-<n>.json`; low-level mode: `.pi/steering/<run-id>.json` | Path to persisted steering state |
| `--event-id` | auto-generated | Unique event identifier |
| `--copilot-input`, `--reviewer-input` | unset | Snapshot-mode inputs for deterministic tests/local integration; operator-facing submit rejects these degraded snapshots |

**Output (stdout, JSON):**
```json
{
  "ok": true,
  "acknowledgement": {
    "runId": "pr-55",
    "directiveKind": "stop_at_next_safe_gate",
    "directive": "Stop before the next safe gate",
    "disposition": "queued_for_safe_point",
    "resultCode": "queued_for_safe_point",
    "reason": "Loop is in 'pr_draft' (not a safe point for immediate application); steering queued for next safe point",
    "inspectedState": "pr_draft",
    "safePointCategory": "next_point",
    "effectiveNow": false,
    "readbackPath": {
      "inspection": "node scripts/loop/inspect-run.mjs --repo \"owner/repo\" --pr \"55\" --steering-state-file \"/abs/path/to/.pi/steering/owner/repo/pr-55.json\"",
      "steeringStatus": "node scripts/loop/steer-loop.mjs status --repo \"owner/repo\" --pr \"55\" --state-file \"/abs/path/to/.pi/steering/owner/repo/pr-55.json\""
    }
  },
  "result": { "...": "low-level acknowledgement detail" },
  "steeringState": { "...": "durable state after the acknowledgement; on rejection, unchanged durable state when it could be loaded and trusted, otherwise a fresh synthetic target-scoped state for deterministic readback output" }
}
```

Operator-facing submit fails closed when the inspection snapshot is partial,
checkpoint-only, unavailable, stale, or conflicting. In those cases it returns
the same top-level success envelope with a rejected acknowledgement.
When the persisted steering file could be loaded and trusted, the response
includes that unchanged durable steering state. When the persisted file is
malformed or target-mismatched, the durable file still remains unchanged, but
the response may include a fresh synthetic target-scoped steering state so
operators still get deterministic readback fields without trusting the broken
persisted contents.

### Inspecting steering state

```sh
node scripts/loop/steer-loop.mjs status \
  --repo <owner/name> \
  --pr <number> \
  [--state-file .pi/steering/<owner>/<repo>/pr-<n>.json]
```

**Output (stdout, JSON):**
```json
{
  "ok": true,
  "status": {
    "runId": "pr-55",
    "target": { "repo": "owner/repo", "pr": 55 },
    "schemaVersion": 1,
    "eventCount": 2,
    "queuedCount": 0,
    "effectiveStackCount": 2,
    "effectiveConstraints": {
      "hardConstraints": ["Do not add new npm dependencies"],
      "preferences": [],
      "clarifications": [],
      "stopAtNextSafeGate": false
    },
    "latestResult": { ... },
    "resultHistory": [ ... ],
    "history": [ ... ],
    "nextSeq": 3
  }
}
```

---

## Live loop integration — detect-copilot-loop-state.mjs

The async Copilot review/fix loop's existing state detector
(`detect-copilot-loop-state.mjs`) is the first execution surface wired to the
steering contract. Pass `--steering-state-file <path>` to make the detector
overlay the detected loop state with the current persisted steering state.
This detector is read-only: steering persistence and queued-promotion ownership
live under `scripts/loop/steer-loop.mjs`.

### How it changes behavior

When `--steering-state-file` is provided:

- The snapshot is interpreted through `resolveEffectiveLoopState` instead of
  `interpretLoopState` directly.
- If a `stop_at_next_safe_gate` directive is on the effective stack **and** the
  loop is currently at an IMMEDIATE safe point, `nextAction` is overridden to
  direct the loop to stop instead of continuing to the next step.
- The output includes `steeringApplied`, `pendingStopAtNextSafeGate`,
  `terminalStopAtNextSafeGate`, and `effectiveConstraints` so downstream
  consumers can inject hard constraints into agent context or check the stop flag.
- When the steering file does not exist (ENOENT), the detector treats it as an
  empty steering state — no error, no change to base behavior.
- The detector does **not** promote queued steering or persist any steering-state
  mutation. Call `node scripts/loop/steer-loop.mjs promote ... --loop-state <state>`
  when the steering owner needs to reconcile queued steering at a known loop state.
- Steering integration is currently available only on explicit `--repo/--pr`
  auto-detect targets; snapshot `--input` mode does not accept
  `--steering-state-file` because repo/pr identity cannot be proven from the
  snapshot alone.

Without `--steering-state-file`, output is identical to the pre-steering behavior
(no steering overlay fields such as `steeringApplied`, `pendingStopAtNextSafeGate`,
`terminalStopAtNextSafeGate`, or `effectiveConstraints`).

### End-to-end workflow

```sh
# 1. Submit steering mid-flight (loop is waiting for Copilot review)
node scripts/loop/steer-loop.mjs submit \
  --repo owner/repo \
  --pr 42 \
  --kind stop_at_next_safe_gate \
  --directive "Stop before next review cycle" \
  --seq 1 \
  --state-file .pi/steering/owner/repo/pr-42.json

# 2. When the steering owner knows the loop is at a safe point, explicitly
#    promote queued steering (if any)
node scripts/loop/steer-loop.mjs promote \
  --repo owner/repo \
  --pr 42 \
  --loop-state ready_to_rerequest_review \
  --state-file .pi/steering/owner/repo/pr-42.json

# 3. Detect state with the steering file (read-only overlay)
node scripts/loop/detect-copilot-loop-state.mjs \
  --repo owner/repo \
  --pr 42 \
  --review-request-status none \
  --steering-state-file .pi/steering/owner/repo/pr-42.json

# Output (nextAction is now overridden at the safe point):
# {
#   "ok": true,
#   "state": "ready_to_rerequest_review",
#   "nextAction": "Stop at this safe gate: a stop_at_next_safe_gate steering directive is active...",
#   "steeringApplied": true,
#   "pendingStopAtNextSafeGate": false,
#   "terminalStopAtNextSafeGate": false,
#   "effectiveConstraints": { "stopAtNextSafeGate": true, "hardConstraints": [], ... }
# }
```

---

## Programmatic integration

For programmatic use (e.g. inside a loop orchestrator), import from the core module:

```js
import {
  STEERING_KIND,
  STEERING_RESULT,
  SAFE_POINT_CATEGORY,
  normalizeSteeringEvent,
  normalizeSteeringState,
  createSteeringState,
  classifySafePoint,
  submitSteering,
  promoteQueuedSteering,
  getEffectiveConstraints,
  resolveEffectiveLoopState,
  getSteeringStatus,
} from "./packages/core/src/loop/steering.mjs";
```

### Integrating with the copilot loop

Use `resolveEffectiveLoopState` instead of `interpretLoopState` when steering may
be active. This function wraps `interpretLoopState` and augments its output:

```js
const { state, nextAction, steeringApplied, effectiveConstraints } =
  resolveEffectiveLoopState(snapshot, steeringState);

// When stop_at_next_safe_gate is active and the loop is at a safe point,
// nextAction is overridden to direct the operator to stop.
if (steeringApplied && effectiveConstraints.stopAtNextSafeGate) {
  // Stop instead of continuing
}

// Inject hard constraints into agent context before a fix step:
for (const constraint of effectiveConstraints.hardConstraints) {
  // Pass to agent as a constraint
}
```

### Promoting queued events on state transition

After each loop state transition, call `promoteQueuedSteering` to apply any
queued events that are now safe to apply:

```js
const { steeringState: updated, promoted } = promoteQueuedSteering(
  steeringState,
  newLoopState,
);
// Persist updated steeringState
// If promoted.length > 0, the effective stack changed
```

---

## Non-goals

- **Free-form prompt injection** into a running child with no explicit schema or acknowledgement.
- **Replacing pause/stop/restart** when the right answer is to stop the run.
- **Mutation rewrites** in the middle of a non-interruptible action.
- **Generalizing immediately** across every loop family (this first slice covers the copilot review/fix loop; other loop families are follow-up work).

## Cross-references

- [Stop Conditions](../skills/docs/stop-conditions.md) — the loop-state stop/wait vocabulary this contract overlays
- [Public Dev Loop Contract](../skills/docs/public-dev-loop-contract.md) — the routing contract this steering layer sits on top of
- [Contract Style Guide](../skills/docs/contract-style-guide.md) — rule-ID conventions used here
