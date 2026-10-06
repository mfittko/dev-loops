# Conductor Routing Contract

Canonical owner for selecting the next loop family and its handoff envelope in an already-targeted active run.

## Overview

This contract starts **after** the active run has been identified (scope/target resolved) and
the copilot/reviewer inner-loop states have been detected (`copilot-loop-state.mjs`,
`reviewer-loop-state.mjs`). It interprets them under the lifecycle semantics of
[PR Lifecycle Contract](./pr-lifecycle-contract.md) without redefining them.
Ownership/idempotency classification is optional (see
[Ownership availability note](#ownership-availability-note)).

<!-- rule: ROUTING-EVALUATOR-AUTHORITY -->
The routing policy source is the [routing statechart](#routing-statechart), evaluated by
`evaluateConductorRouting`. The evaluator **MUST** derive the routing outcome directly from
normalized state inputs; it **MUST NOT** accept a pre-computed outer-loop action. It is the
routing authority, not a remapper.

## Boundary

This contract decides _which loop family_ gets control. It does **not** define:
- which run is active, ownership-key design, duplicate-owner handling, or start/attach/resume idempotency (#32; conductor implementation retired, issue #319)
- PR lifecycle state semantics, gate order, draft/ready transitions, remediation ownership classes, or approval-gate semantics ([PR Lifecycle Contract](./pr-lifecycle-contract.md))
- Copilot request/re-request/watch helper semantics (#34)
- PR-visible projection or closeout artifacts (#48)
- inspection, viewer, or steering surfaces (#57/#58/#59)
- family-local state machines (copilot-loop-state.mjs, reviewer-loop-state.mjs)
- backend discovery, remote polling, or transport coordination
- a generic multi-family conductor beyond the current Copilot PR outer-loop family
- board synchronization and queue-column state transitions for tracked items — the conductor's continuous board-sync obligation is owned by [QUEUE-BOARD-SYNC-CONTINUOUS](projects-queue-contract.md#conductor-board-synchronization-responsibility) in the projects queue contract <!-- rule-ref: QUEUE-BOARD-SYNC-CONTINUOUS -->

Parent umbrella: [#28](https://github.com/mfittko/dev-loops/issues/28).

## Implementation

| Component | Location |
|---|---|
| Core routing evaluator | `packages/core/src/loop/conductor-routing.mjs` |
| Routing statechart (policy source) | `packages/core/src/loop/conductor-routing-statechart.json` |
| Core unit tests | `packages/core/test/conductor-routing.test.mjs` |
| Statechart structure and coverage tests | `packages/core/test/conductor-routing-statechart.test.mjs` |
| Golden regression test and fixture | `packages/core/test/conductor-routing-golden.test.mjs`, `packages/core/test/fixtures/conductor-routing-golden.json` |
| Contract table freshness test | `packages/core/test/conductor-routing-contract-table.test.mjs` |
| Integration tests (outer-loop adapter) | `test/loop/conductor-routing.test.mjs` |
| Thin adapter integration | `scripts/loop/outer-loop.mjs` (calls evaluator as routing authority; emits `conductorRouting` in output) |

---

## Routing inputs

The evaluator (`evaluateConductorRouting`) consumes a single normalized input object. Unknown
extra fields are ignored.

### Required inputs

| Field | Type | Description |
|---|---|---|
| `target` | `{ repo: string, pr: number }` | Explicit target identity — already resolved by the caller |
| `copilotState` | `string` | Already-detected copilot loop lifecycle state (from `STATE` constants in `copilot-loop-state.mjs`) |
| `reviewerState` | `string` | Already-detected reviewer loop lifecycle state (from `REVIEWER_STATE` constants in `reviewer-loop-state.mjs`) |

### Target normalization and malformed-target behavior

For valid targets, the evaluator normalizes `target.repo` to `target.repo.trim().toLowerCase()`
and keeps `target.pr` as the positive integer.

When `target` is missing or malformed, routing fails closed to `needs_reconcile`.
In that fail-closed result, `handoffEnvelope.targetIdentity` is stable:
- `null` when `target` is absent or not an object
- otherwise `{ repo: string | null, pr: number | null }`, where:
  - `repo` is lowercased+trimmed when a non-empty repo string is present, else `null`
  - `pr` is the positive integer when valid, else `null`

### Optional inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `ownershipState` | `string` | `undefined` | Settled ownership/idempotency classification. `"live_owner"` → `stay_with_current_live_owner` for active states. `"duplicate_local_owners"` → `needs_reconcile`. Other values or omission → routing continues purely from states. |
| `sourceMode` | `string` | `"local"` | Source/confidence mode: `"authoritative"` \| `"local"` \| `"snapshot"` |
| `requiresLocalIsolation` | `boolean` | `false` | Whether the checkout is dirty or detached; callers must continue local-execution handoffs from an isolated checkout/worktree when this is true |

### Ownership availability note

The current `outer-loop.mjs` integration seam does **not** supply `ownershipState`; the
conductor-ownership module was retired (issue #319; designs in git history). The
ownership-aware branches (`stay_with_current_live_owner`, duplicate-owner reconcile) are
implemented and unit-tested, and activate when a caller supplies `ownershipState`.

### Direct routing vs reconcile

Direct routing (no reconcile) needs all required fields present and valid, with
`ownershipState` absent or any value except `"duplicate_local_owners"`. Every other input
combination reconciles first per `ROUTING-FAIL-CLOSED-RECONCILE`
(see [Conflict and fail-closed rules](#conflict-and-fail-closed-rules)).

---

## Return shape

`evaluateConductorRouting` returns:

| Field | Type | Description |
|---|---|---|
| `routingOutcome` | `string` | One of the 7 closed routing outcome values |
| `outerAction` | `string` | Derived outer-loop action (for backward compat with `outer-loop.mjs` checkpoint/output shape) |
| `stopReason` | `string | null` | Stop reason code (from `STOP_REASON` constants) when `outerAction` is `"stop"`; `null` otherwise. `ownershipState === "duplicate_local_owners"` emits `"ownership_conflict"`; unmapped state combinations continue to use `"unknown_state"`. |
| `handoffEnvelope` | `object` | Machine-readable handoff payload (see below) |

---

## Routing outcome taxonomy

| Outcome | Meaning | Loop family |
|---|---|---|
| `continue_current_wait` | Orchestrator wait state; re-enter after bounded wait interval | `outer_loop` |
| `handoff_to_copilot_loop` | Copilot inner loop should handle the next step | `copilot_loop` |
| `handoff_to_reviewer_loop` | Reviewer inner loop should handle the next step | `reviewer_loop` |
| `stay_with_current_live_owner` | A live owner already has control; no new handoff needed this cycle | `outer_loop` |
| `stop_needs_human` | Blocked; requires human intervention before any loop can proceed | none |
| `done_terminal` | PR is merged, closed, or fully done; no further action needed | none |
| `needs_reconcile` | Ambiguous, conflicting, stale, or insufficient signals | none |

---

## Required transitions

The outer-loop graph (`OUTER_STATE` / `OUTER_TRANSITIONS` in `conductor-routing.mjs`) is
stateless per cycle, so every non-terminal outcome can be followed by any of the 7 outcomes
on the next cycle.

- `continue_current_wait` -> any outer state
- `handoff_to_copilot_loop` -> any outer state
- `handoff_to_reviewer_loop` -> any outer state
- `stay_with_current_live_owner` -> any outer state

Terminal states (`stop_needs_human`, `done_terminal`, `needs_reconcile`) have no outgoing
transitions — reaching one ends the current evaluation cycle.

---

## Handoff envelope

Every routing decision emits a `handoffEnvelope` with the following fields:

| Field | Type | Description |
|---|---|---|
| `targetIdentity` | `{ repo: string, pr: number } \| { repo: string \| null, pr: number \| null } \| null` | Normalized target identity for downstream workers; malformed-target fail-closed results use the stable degraded shape described above |
| `loopFamily` | `string | null` | Which loop family receives control; `null` for terminal/blocked/reconcile |
| `entrypoint` | `string | null` | Specific handler identifier; `null` when no automated handler applies |
| `reason` | `string` | Human-readable reason/evidence summary for the routing decision |
| `requiredArgs` | `object` | Minimum args required by the entrypoint handler (`{ repo, pr }` for routed results, `{}` for pre-check results 0a, 0b and 0c) |
| `requiresLocalIsolation` | `boolean` | Whether the next step needs an isolated local checkout |
| `confidence` | `string` | Source mode: `"authoritative"` \| `"local"` \| `"snapshot"` |

### Entrypoint identifiers

| Entrypoint | Handler | Used for |
|---|---|---|
| `copilot_pr_handoff` | `scripts/loop/copilot-pr-handoff.mjs` | Copilot loop re-entry |
| `reviewer_loop_handler` | Reviewer-side loop handler | Reviewer loop re-entry |
| `outer_loop_wait` | `scripts/loop/outer-loop.mjs` (wait path) | Outer wait re-run |
| `null` | none | Terminal, blocked, or reconcile states |

---

## Routing policy (priority order)

<!-- rule: ROUTING-PRIORITY-ORDER -->
The evaluator **MUST** apply the following first-match-wins priority order:

| Priority | Condition | Routing outcome |
|---|---|---|
| 0a | `target` is missing or malformed | `needs_reconcile` (`unknown_state`) |
| 0b | `copilotState` is missing or blank | `needs_reconcile` (`unknown_state`) |
| 0c | `reviewerState` is missing or blank | `needs_reconcile` (`unknown_state`) |
| 1 | `ownershipState === "duplicate_local_owners"` | `needs_reconcile` (`ownership_conflict`) |
| 2 | `copilotState === "done"` | `done_terminal` |
| 3 | `copilotState === "no_pr"` | `stop_needs_human` (`pr_not_ready`) |
| 4 | `copilotState === "review_request_unavailable"` | `stop_needs_human` (`review_unavailable`) |
| 5 | `copilotState === "blocked_needs_user_decision"` | `stop_needs_human` (`copilot_blocked`) |
| 6 | `reviewerState === "blocked_needs_user_decision"` | `stop_needs_human` (`reviewer_blocked`) |
| 7 | `copilotState === "pr_draft"` + `ownershipState === "live_owner"` | `stay_with_current_live_owner` |
| 8 | `copilotState === "pr_draft"` | `handoff_to_copilot_loop` (`requiresLocalIsolation` passthrough when true) |
| 9 | `copilotState === "waiting_for_copilot_review"` | `continue_current_wait` |
| 10 | reviewer active state + `ownershipState === "live_owner"` | `stay_with_current_live_owner` |
| 11 | reviewer active state | `handoff_to_reviewer_loop` (`requiresLocalIsolation` passthrough when true) |
| 12 | copilot strong-active + `ownershipState === "live_owner"` | `stay_with_current_live_owner` |
| 13 | copilot strong-active | `handoff_to_copilot_loop` (`requiresLocalIsolation` passthrough when true) |
| 14 | copilot wait state OR reviewer wait state | `continue_current_wait` |
| 15 | copilot weak-active + `ownershipState === "live_owner"` | `stay_with_current_live_owner` |
| 16 | copilot weak-active | `handoff_to_copilot_loop` |
| 17 | anything else | `needs_reconcile` (`unknown_state`) |

Rule 17 also catches `low_signal_converged`, `round_cap_reached`, `round_cap_clean_fallback` and `internal_tooling_direct_gate`: when no earlier row matches (for example with reviewer state `waiting_for_review_request`) they reach `needs_reconcile` with stop reason `unknown_state`.

**Copilot strong-active states** (win over reviewer wait states): `unresolved_feedback_present`, `already_fixed_needs_reply_resolve`

**Copilot weak-active states** (yield to reviewer wait states): `pr_ready_no_feedback`, `ready_to_rerequest_review`

**Reviewer active states**: `review_requested`, `determine_review_plan`, `reviews_running`, `merge_results`, `draft_review_ready`, `draft_review_posted`, `waiting_for_user_submit`, `review_invalidated`

**Reviewer active states needing local execution**: `review_requested`, `determine_review_plan`, `reviews_running`, `merge_results`, `draft_review_ready`

<!-- rule: ROUTING-LOCAL-ISOLATION-PASSTHROUGH -->
When `requiresLocalIsolation=true`, those local-execution states **MUST NOT** become terminal stop outcomes by themselves. The routing result **MUST** stay on the owning loop family and **MUST** carry `handoffEnvelope.requiresLocalIsolation=true` so the caller can re-enter from a safe isolated checkout/worktree.

**Copilot/reviewer wait states** (owned by orchestrator): `waiting_for_copilot_review`, `waiting_for_ci` (copilot); `submitted_review`, `re_review_needed`, `waiting_for_author_followup`, `waiting_for_re_request` (reviewer)

`waiting_for_copilot_review` is a post-request settle gate for the current head: routing stays `continue_current_wait` until that Copilot pass settles, even when reviewer-side state is active (priority 9).

---

## Routing statechart

The priority table above is hand-written. Its policy source is the JSON chart at `packages/core/src/loop/conductor-routing-statechart.json`, which uses the XState v5 key vocabulary (`id`, `initial`, `context`, `states`, `always`, `target`, `guard`, `meta`, `type`) and no runtime dependency.

- The `route` state holds the `always` arrows in first-match order: pre-checks `0a`, `0b`, `0c`, then rules 1 to 17. The runner takes the first arrow whose guard holds. Rule 17 has no guard and is last.
- Each arrow targets a final state named after a routing outcome. The final state's `meta` supplies `outerAction`, `loopFamily` and `entrypoint`. The arrow's `meta` supplies `rule`, `stopReason` and `preCheck`.
- The guard predicates and the reason texts, keyed by rule, live in `packages/core/src/loop/conductor-routing.mjs`. `evaluateConductorRouting` normalizes the input, runs the chart and builds the envelope. Pre-check results carry empty `requiredArgs`.
- Coverage invariants: no arrow is dead over the full input product, and the golden test (`packages/core/test/conductor-routing-golden.test.mjs`) pins every result of that product (24,480 inputs) against the fixture `packages/core/test/fixtures/conductor-routing-golden.json`.
- A freshness test fails when the `ROUTING-PRIORITY-ORDER` table differs from the chart arrows in row order, rule ids, outcomes or stop reasons.

---

## Conflict and fail-closed rules

<!-- rule: ROUTING-FAIL-CLOSED-RECONCILE -->
The evaluator **MUST** fail closed to `needs_reconcile` rather than guessing a handoff when:

1. **Target is unresolved**: `target` is missing, `null`, or missing required `repo`/`pr` fields.
2. **State inputs are absent**: `copilotState` or `reviewerState` is missing or empty.
3. **Ownership conflict**: `ownershipState === "duplicate_local_owners"`.
4. **Unrecognized combined state**: the `copilotState`/`reviewerState` combination does not match any routing rule.

A fail-closed result (`needs_reconcile` or `stop_needs_human`) **MUST NOT** carry a live
handoff: `handoffEnvelope.loopFamily` and `handoffEnvelope.entrypoint` are `null` (epic #1104).

---

## Scenario matrix

| # | `copilotState` | `reviewerState` | Other input | `routingOutcome` | `outerAction` | `loopFamily` | `entrypoint` |
|---|---|---|---|---|---|---|---|
| 1 | `"waiting_for_copilot_review"` | `"waiting_for_review_request"` | none | `"continue_current_wait"` | `"continue_wait"` | `"outer_loop"` | `"outer_loop_wait"` |
| 2 | `"pr_ready_no_feedback"` | `"review_requested"` | none | `"handoff_to_reviewer_loop"` | `"reenter_reviewer_loop"` | `"reviewer_loop"` | `"reviewer_loop_handler"` |
| 3 | `"unresolved_feedback_present"` | `"waiting_for_author_followup"` | none | `"handoff_to_copilot_loop"` | `"reenter_copilot_loop"` | `"copilot_loop"` | `"copilot_pr_handoff"` |
| 4 | `"blocked_needs_user_decision"` | `"waiting_for_review_request"` | none | `"stop_needs_human"` (`stopReason` `"copilot_blocked"`) | `"stop"` | `null` | `null` |
| 5 | `"done"` | any | none | `"done_terminal"` | `"done"` | `null` | `null` |
| 6 | `"unresolved_feedback_present"` | `"waiting_for_author_followup"` | `ownershipState` `"live_owner"` (unit tests only) | `"stay_with_current_live_owner"` | `"continue_wait"` | `"outer_loop"` | `"outer_loop_wait"` |

Non-target and noise inputs fail closed to `"needs_reconcile"`: `target` is `null`,
`target.pr` is not a positive integer, `copilotState` is an empty string, or the combined
state is unrecognized.
