# Conductor Routing Contract

This document defines the **conductor routing contract** for an already-targeted active run: which loop family
owns the next active step, and what machine-readable handoff payload should be emitted.

## Overview

The conductor routing layer answers one specific question after ownership and family-local lifecycle state are
already known:

> For this active run, which loop family should receive control now, and what exact handoff envelope should
> downstream workers consume?

This contract starts **after**:
- the active run has been identified (scope/target resolved)
- ownership/idempotency classification is optional (the `conductor-ownership.mjs` module and its issue #32 have been retired; designs archived in git history); when supplied, `ownershipState` activates routing branches such as `stay_with_current_live_owner`
- the copilot/reviewer inner-loop state-machine outputs have been detected (from `copilot-loop-state.mjs` and `reviewer-loop-state.mjs`) and are interpreted under the broader family-local PR lifecycle semantics frozen in [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md)

The routing outcome is derived **directly from normalized state inputs** — the evaluator does not accept a
pre-computed outer-loop action. It is the routing authority, not a remapper.

## Relationship to other contracts

| Contract / Issue | Relationship |
|---|---|
| [#28 — conductor umbrella](https://github.com/mfittko/dev-loops/issues/28) | Parent umbrella |
| [#32 — ownership/idempotency](https://github.com/mfittko/dev-loops/issues/32) | **Historical**: designed the ownership model; the `conductor-ownership.mjs` module was retired during deslop cleanup (issue #319). `ownershipState` remains as an optional external input. |
| [#26 — family-local PR lifecycle contract](https://github.com/mfittko/dev-loops/issues/26) / [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md) | **Upstream**: provides family-local PR lifecycle semantics; the concrete `copilotState` and `reviewerState` inputs still come from the existing copilot/reviewer state machines, and this contract consumes them without redefining their semantics |
| [#34 — request/watch helper contract](https://github.com/mfittko/dev-loops/issues/34) | **Adjacent**: defines Copilot request/watch semantics inside the copilot loop family; this contract decides _which family_ gets control |
| [#48 — visible PR projection](https://github.com/mfittko/dev-loops/issues/48) | **Downstream**: routing decisions may drive PR projection artifacts |
| [#57/#58/#59 — inspection/viewer/steering](https://github.com/mfittko/dev-loops/issues/57) | **Adjacent**: read-only inspection surfaces; this contract defines routing policy, not operator UX |

## Boundary

This contract owns **conductor routing and handoff decisions after ownership and family-local state are already known**.

It does **not** define:
- which run is active (ownership/idempotency rules; the conductor implementation was retired, see issue #319)
- PR lifecycle state semantics, gate order, or draft/ready transitions (from [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md))
- Copilot request/re-request/watch helper semantics (from #34)
- PR-visible projection artifacts (from #48)
- inspection, viewer, or steering surfaces (from #57/#58/#59)
- family-local state machines (copilot-loop-state.mjs, reviewer-loop-state.mjs)
- backend discovery, remote polling, or transport coordination

## Implementation

| Component | Location |
|---|---|
| Core routing evaluator | `packages/core/src/loop/conductor-routing.mjs` |
| Core unit tests | `packages/core/test/conductor-routing.test.mjs` |
| Integration tests (outer-loop adapter) | `test/loop/conductor-routing.test.mjs` |
| Thin adapter integration | `scripts/loop/outer-loop.mjs` (calls evaluator as routing authority; emits `conductorRouting` in output) |

---

## Routing inputs

The evaluator (`evaluateConductorRouting`) consumes a single normalized input object.

### Required inputs

| Field | Type | Description |
|---|---|---|
| `target` | `{ repo: string, pr: number }` | Explicit target identity — already resolved by the caller |
| `copilotState` | `string` | Already-detected copilot loop lifecycle state (from `STATE` constants in `copilot-loop-state.mjs`) |
| `reviewerState` | `string` | Already-detected reviewer loop lifecycle state (from `REVIEWER_STATE` constants in `reviewer-loop-state.mjs`) |

### Target normalization and malformed-target behavior

For valid targets, the evaluator normalizes:
- `target.repo` -> `target.repo.trim().toLowerCase()`
- `target.pr` -> unchanged positive integer

When `target` is missing or malformed, routing fails closed to `needs_reconcile`.
In that fail-closed result, `handoffEnvelope.targetIdentity` is stable:
- `null` when `target` is absent or not an object
- otherwise `{ repo: string | null, pr: number | null }`, where:
  - `repo` is lowercased+trimmed when a non-empty repo string is present, else `null`
  - `pr` is the positive integer when valid, else `null`

### Optional inputs

| Field | Type | Default | Description |
|---|---|---|---|
| `ownershipState` | `string` | `undefined` | Settled ownership/idempotency classification (conductor-ownership module retired; see git history and issue #319). `"live_owner"` → `stay_with_current_live_owner` for active states. `"duplicate_local_owners"` → `needs_reconcile`. Other values or omission → routing continues purely from states. **See ownership availability note below.** |
| `sourceMode` | `string` | `"local"` | Source/confidence mode: `"authoritative"` \| `"local"` \| `"snapshot"` |
| `requiresLocalIsolation` | `boolean` | `false` | Whether the checkout is dirty or detached; callers must continue local-execution handoffs from an isolated checkout/worktree when this is true |

### Ownership availability note

`ownershipState` is an optional caller-supplied input. **The current `outer-loop.mjs` integration seam does not
supply it** — the orchestrator does not yet resolve conductor ownership (the conductor-ownership module has been retired; see git history and issue #319 for its design).
The ownership-aware routing branches (`stay_with_current_live_owner`, duplicate-owner reconcile) are fully
implemented and unit-tested; they become active when a caller that has already resolved ownership supplies
`ownershipState`.
### Sufficient signals for direct routing

The following input combinations are sufficient for direct routing (no reconcile needed):

| Input condition | Direct routing allowed |
|---|---|
| All required fields present and valid | ✓ |
| `ownershipState` is absent or any value except `"duplicate_local_owners"` | ✓ |

### Inputs that require reconcile first

| Input condition | Why reconcile is required |
|---|---|
| `target` is missing or malformed | Cannot route without resolved target identity |
| `copilotState` is missing or empty | Cannot route without family-local state |
| `reviewerState` is missing or empty | Cannot route without family-local state |
| `ownershipState === "duplicate_local_owners"` | Multiple local owners; ownership must be resolved first |
| Unrecognized combined state (not mapped by routing policy) | Ambiguous inputs; reconcile before routing |

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

## Handoff envelope

Every routing decision emits a `handoffEnvelope` with the following fields:

| Field | Type | Description |
|---|---|---|
| `targetIdentity` | `{ repo: string, pr: number } \| { repo: string \| null, pr: number \| null } \| null` | Normalized target identity for downstream workers; malformed-target fail-closed results use the stable degraded shape described above |
| `loopFamily` | `string | null` | Which loop family receives control; `null` for terminal/blocked/reconcile |
| `entrypoint` | `string | null` | Specific handler identifier; `null` when no automated handler applies |
| `reason` | `string` | Human-readable reason/evidence summary for the routing decision |
| `requiredArgs` | `object` | Minimum args required by the entrypoint handler (`{ repo, pr }` at minimum) |
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

The evaluator applies the following first-match-wins priority order:

| Priority | Condition | Routing outcome |
|---|---|---|
| 1 | `ownershipState === "duplicate_local_owners"` | `needs_reconcile` |
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
| 17 | anything else | `needs_reconcile` |

**Copilot strong-active states** (win over reviewer wait states): `unresolved_feedback_present`, `already_fixed_needs_reply_resolve`

**Copilot weak-active states** (yield to reviewer wait states): `pr_ready_no_feedback`, `ready_to_rerequest_review`

**Reviewer active states**: `review_requested`, `determine_review_plan`, `reviews_running`, `merge_results`, `draft_review_ready`, `draft_review_posted`, `waiting_for_user_submit`, `submitted_review`, `review_invalidated`

**Reviewer active states needing local execution**: `review_requested`, `determine_review_plan`, `reviews_running`, `merge_results`, `draft_review_ready`

When `requiresLocalIsolation=true`, those local-execution states do **not** become terminal stop outcomes by themselves. The routing result stays on the owning loop family and carries `handoffEnvelope.requiresLocalIsolation=true` so the caller can re-enter from a safe isolated checkout/worktree.

**Copilot/reviewer wait states** (owned by orchestrator): `waiting_for_copilot_review`, `waiting_for_ci` (copilot); `waiting_for_author_followup`, `waiting_for_re_request` (reviewer)

`waiting_for_copilot_review` is an explicit post-request settle gate for the current head: this routing contract keeps `continue_current_wait` semantics until that fresh Copilot pass has settled, even if reviewer-side state is otherwise active.

---

## Conflict and fail-closed rules

The evaluator fails closed to `needs_reconcile` rather than guessing a handoff when:

1. **Target is unresolved**: `target` is missing, `null`, or missing required `repo`/`pr` fields.
2. **State inputs are absent**: `copilotState` or `reviewerState` is missing or empty.
3. **Ownership conflict**: `ownershipState === "duplicate_local_owners"`.
4. **Unrecognized combined state**: the `copilotState`/`reviewerState` combination does not match any routing rule.

### Non-goal: this rule does not apply to noise fields

Callers may pass extra fields on the input object; unknown fields are ignored. Only the declared
required and optional fields listed above affect routing decisions.

---

## Scenario matrix

### 1. Outer wait remains outer wait

| Field | Value |
|---|---|
| `copilotState` | `"waiting_for_copilot_review"` |
| `reviewerState` | `"waiting_for_review_request"` |
| Expected `routingOutcome` | `"continue_current_wait"` |
| `outerAction` (derived) | `"continue_wait"` |
| `loopFamily` | `"outer_loop"` |
| `entrypoint` | `"outer_loop_wait"` |

### 2. Reviewer-active routes to reviewer-loop handoff

| Field | Value |
|---|---|
| `copilotState` | `"pr_ready_no_feedback"` |
| `reviewerState` | `"review_requested"` |
| Expected `routingOutcome` | `"handoff_to_reviewer_loop"` |
| `outerAction` (derived) | `"reenter_reviewer_loop"` |
| `loopFamily` | `"reviewer_loop"` |
| `entrypoint` | `"reviewer_loop_handler"` |

### 3. Copilot-active routes to Copilot-loop handoff

| Field | Value |
|---|---|
| `copilotState` | `"unresolved_feedback_present"` |
| `reviewerState` | `"waiting_for_author_followup"` |
| Expected `routingOutcome` | `"handoff_to_copilot_loop"` |
| `outerAction` (derived) | `"reenter_copilot_loop"` |
| `loopFamily` | `"copilot_loop"` |
| `entrypoint` | `"copilot_pr_handoff"` |

### 4. Blocked routes to stop_needs_human

| Field | Value |
|---|---|
| `copilotState` | `"blocked_needs_user_decision"` |
| `reviewerState` | `"waiting_for_review_request"` |
| Expected `routingOutcome` | `"stop_needs_human"` |
| `outerAction` (derived) | `"stop"` |
| `stopReason` | `"copilot_blocked"` |
| `loopFamily` | `null` |
| `entrypoint` | `null` |

### 5. Terminal state routes to done_terminal

| Field | Value |
|---|---|
| `copilotState` | `"done"` |
| `reviewerState` | any |
| Expected `routingOutcome` | `"done_terminal"` |
| `outerAction` (derived) | `"done"` |
| `loopFamily` | `null` |
| `entrypoint` | `null` |

### 6. Live owner suppresses handoff (ownership-aware path)

**Note**: this path is exercised by unit tests only. The `outer-loop.mjs` integration seam does not supply
`ownershipState` yet; the conductor-ownership module has been retired (issue #319).

| Field | Value |
|---|---|
| `copilotState` | `"unresolved_feedback_present"` |
| `reviewerState` | `"waiting_for_author_followup"` |
| `ownershipState` | `"live_owner"` |
| Expected `routingOutcome` | `"stay_with_current_live_owner"` |
| `outerAction` (derived) | `"continue_wait"` |
| `loopFamily` | `"outer_loop"` |
| `entrypoint` | `"outer_loop_wait"` |

### 7. Non-target / noise inputs fail closed

| Condition | Expected `routingOutcome` |
|---|---|
| `target` is `null` | `"needs_reconcile"` |
| `target.pr` is not a positive integer | `"needs_reconcile"` |
| `copilotState` is empty string | `"needs_reconcile"` |
| Unrecognized combined state | `"needs_reconcile"` |

---

## Non-goals

This contract intentionally does **not** cover:

- ownership-key design, duplicate-owner handling, or start/attach/resume idempotency rules (→ #32, conductor implementation retired, see issue #319)
- wiring `ownershipState` into `outer-loop.mjs` or any other caller (deferred; conductor implementation retired)
- PR lifecycle states, draft/ready gate order, remediation ownership classes, or approval-gate semantics (→ [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md))
- Copilot request / re-request / watch helper semantics (→ #34)
- inspection, viewer, or steering surface design (→ #57/#58/#59)
- PR-visible projection / closeout artifacts (→ #48)
- replacing or redefining the existing family-local state machines
- backend discovery, remote polling, or transport coordination
- broad generic multi-family conductor rollout beyond the current Copilot PR outer-loop family
